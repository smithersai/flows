import { z } from "zod";
import { composeAgentInstructions } from "../shared/AgentContext";
import { CardPatchSchema, CardSchema } from "../shared/Cards";
import { AgentTurnDoneReasonSchema } from "../shared/NativeAgent";
import type {
	AgentTurnFrame,
	FetchLike,
	StartAgentTurnRequest,
	StartAgentTurnResult,
} from "../shared/NativeAgent";

const DEFAULT_CHAT_URL = "https://chat.smithers.sh/chat";
const DEFAULT_APP_ORIGIN = "https://smithers.sh";
const MAX_ERROR_BYTES = 320;

export interface CloudAgentConfig {
	readonly chatUrl?: string;
	readonly origin?: string;
	readonly fetchImpl?: FetchLike;
}

type PublishFrame = (frame: AgentTurnFrame) => void;

/** The upstream wire frame: an AgentTurnFrame without its runId (added on publish). */
const WireAgentFrameSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("delta"),
		kind: z.enum(["reasoning", "text"]),
		text: z.string(),
	}),
	z.object({
		type: z.literal("done"),
		reason: AgentTurnDoneReasonSchema.optional(),
		error: z.string().optional(),
	}),
	z.object({ type: z.literal("card"), card: CardSchema }),
	z.object({ type: z.literal("card.update"), id: z.string(), patch: CardPatchSchema }),
	z.object({
		type: z.literal("tool_call"),
		call_id: z.string(),
		name: z.string(),
		arguments: z.string(),
	}),
]);
type WireAgentFrame = z.infer<typeof WireAgentFrameSchema>;

const isFrame = (value: unknown): value is WireAgentFrame =>
	WireAgentFrameSchema.safeParse(value).success;

const responseError = async (response: Response): Promise<string> => {
	const detail = (await response.text().catch(() => "")).trim().slice(0, MAX_ERROR_BYTES);
	return `Smithers Cloud chat failed (HTTP ${response.status})${detail === "" ? "." : `: ${detail}`}`;
};

const streamTurn = async (
	request: StartAgentTurnRequest,
	abortController: AbortController,
	publish: PublishFrame,
	config: CloudAgentConfig,
): Promise<void> => {
	const response = await (config.fetchImpl ?? fetch)(config.chatUrl?.trim() || DEFAULT_CHAT_URL, {
		method: "POST",
		signal: abortController.signal,
		headers: {
			"content-type": "application/json",
			origin: config.origin?.trim() || DEFAULT_APP_ORIGIN,
			"x-smithers-run-id": request.runId,
		},
		body: JSON.stringify({
			messages: request.messages,
			// The hidden runtime context is rendered server-side into the
			// instructions: upstream sees one string, secrets and structure
			// stay on this side, and the visible transcript never holds it.
			instructions: composeAgentInstructions(request.instructions, request.context),
			// The tool-loop contract (Wave 3b): the tool specs ride every turn on
			// this boundary exactly as they do on the product Worker, otherwise the
			// model is never offered a command and the loop can never start.
			...(request.tools === undefined ? {} : { tools: request.tools }),
		}),
	});
	if (!response.ok || response.body === null) {
		throw new Error(
			response.ok ? "Smithers Cloud returned no response stream." : await responseError(response),
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let settled = false;
	const readLine = (line: string): void => {
		if (line.trim() === "") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isFrame(parsed)) return;
		switch (parsed.type) {
			case "delta":
				publish({ runId: request.runId, type: "delta", kind: parsed.kind, text: parsed.text });
				break;
			case "card":
				publish({ runId: request.runId, type: "card", card: parsed.card });
				break;
			case "card.update":
				publish({ runId: request.runId, type: "card.update", id: parsed.id, patch: parsed.patch });
				break;
			case "tool_call":
				publish({
					runId: request.runId,
					type: "tool_call",
					call_id: parsed.call_id,
					name: parsed.name,
					arguments: parsed.arguments,
				});
				break;
			case "done":
				publish({
					runId: request.runId,
					type: "done",
					// `reason` is how the client tells an ordinary stop from the
					// upstream tool-call cap; dropping it turned an honest
					// tool_limit into a bare "empty response".
					...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
					...(parsed.error ? { error: parsed.error } : {}),
				});
				settled = true;
				break;
		}
	};

	for (;;) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split("\n");
		buffer = done ? "" : (lines.pop() ?? "");
		for (const line of lines) readLine(line);
		if (done || settled) break;
	}
	if (!settled) publish({ runId: request.runId, type: "done" });
};

export interface CloudAgent {
	readonly start: (request: StartAgentTurnRequest) => StartAgentTurnResult;
	readonly cancel: (runId: string) => { readonly status: "cancelled" | "not-found" };
}

export const createCloudAgent = (
	publish: PublishFrame,
	config: CloudAgentConfig = {},
): CloudAgent => {
	const activeTurns = new Map<string, AbortController>();
	return {
		start: (request) => {
			if (activeTurns.has(request.runId)) {
				return { status: "error", message: "That Smithers turn is already running." };
			}
			const abortController = new AbortController();
			activeTurns.set(request.runId, abortController);
			void streamTurn(request, abortController, publish, config)
				.catch((error: unknown) => {
					if (abortController.signal.aborted) return;
					publish({
						runId: request.runId,
						type: "done",
						error: error instanceof Error ? error.message : "Smithers Cloud chat failed.",
					});
				})
				.finally(() => activeTurns.delete(request.runId));
			return { status: "started" };
		},
		cancel: (runId) => {
			const active = activeTurns.get(runId);
			if (active === undefined) return { status: "not-found" };
			active.abort();
			activeTurns.delete(runId);
			return { status: "cancelled" };
		},
	};
};
