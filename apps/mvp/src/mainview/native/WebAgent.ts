import { CANCEL_PATH, TURN_PATH } from "../../shared/AgentApiRoutes";
import { isAgentTurnFrame } from "../../shared/NativeAgent";
import type { AgentTurnFrame, FetchLike, StartAgentTurnResult } from "../../shared/NativeAgent";
import type { NativeAgent } from "./NativeBridge";

const MAX_ERROR_BYTES = 320;

export interface WebAgentOptions {
	/** Same-origin Vite dev proxy by default; override for tests or a deployed boundary. */
	readonly baseUrl?: string;
	readonly fetchImpl?: FetchLike;
}

/** The boundary answers failures as `{ status, message }`; surface that, not raw JSON. */
const errorDetail = async (response: Response): Promise<string> => {
	const body = (await response.text().catch(() => "")).trim();
	let detail = body;
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"message" in parsed &&
			typeof parsed.message === "string"
		) {
			detail = parsed.message;
		}
	} catch {
		// A non-JSON body (a proxy error page, say) is already the best detail available.
	}
	detail = detail.slice(0, MAX_ERROR_BYTES);
	return `Smithers web agent failed (HTTP ${response.status})${detail === "" ? "." : `: ${detail}`}`;
};

const streamFrames = async (
	body: ReadableStream<Uint8Array>,
	expectedRunId: string,
	publish: (frame: AgentTurnFrame) => void,
	onTerminal?: () => void,
): Promise<void> => {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let settled = false;
	for (;;) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const lines = buffer.split("\n");
		buffer = done ? "" : (lines.pop() ?? "");
		for (const line of lines) {
			if (line.trim() === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isAgentTurnFrame(parsed) || parsed.runId !== expectedRunId) continue;
			publish(parsed);
			if (parsed.type === "done") {
				settled = true;
				// Release the turn's cancel handle BEFORE the stream teardown
				// settles: a tool-loop continuation leg re-POSTs this runId the
				// moment the terminal frame is published, and must not meet a
				// stale "already running" from this agent's own map.
				onTerminal?.();
			}
		}
		if (done || settled) break;
	}
	// A `done` frame ends the turn even if the boundary keeps the socket open.
	if (settled) {
		await reader.cancel().catch(() => {});
	} else {
		// The stream ended without a terminal frame: the turn died server-side
		// (upstream disconnect). That is an honest failure, never a silent stall.
		publish({
			runId: expectedRunId,
			type: "done",
			error: "The response stream ended before Smithers finished the turn.",
		});
	}
};

/**
 * Pure-web counterpart to the Electrobun RPC agent: POSTs turns to the same-origin
 * `/api/agent` boundary (the Vite dev proxy in development) which keeps the
 * chat.smithers.sh credentials and origin server-side, then renders the streamed
 * NDJSON AgentTurnFrames exactly like the native bridge does.
 */
export const createWebAgent = (options: WebAgentOptions = {}): NativeAgent => {
	const baseUrl = options.baseUrl ?? "";
	const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
	const listeners = new Set<(frame: AgentTurnFrame) => void>();
	const activeTurns = new Map<string, AbortController>();
	const publish = (frame: AgentTurnFrame): void => {
		for (const listener of listeners) listener(frame);
	};

	return {
		available: true,
		startTurn: async (request): Promise<StartAgentTurnResult> => {
			if (activeTurns.has(request.runId)) {
				return { status: "error", message: "That Smithers turn is already running." };
			}
			const abortController = new AbortController();
			// Registered before the request so a stop pressed while still connecting aborts it.
			activeTurns.set(request.runId, abortController);
			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}${TURN_PATH}`, {
					method: "POST",
					signal: abortController.signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify(request),
				});
			} catch (error) {
				activeTurns.delete(request.runId);
				// A cancelled connect is the user's own doing, not a failed turn to report.
				if (abortController.signal.aborted) return { status: "started" };
				return {
					status: "error",
					message:
						error instanceof Error
							? `Could not reach the Smithers web agent: ${error.message}`
							: "Could not reach the Smithers web agent.",
				};
			}
			if (!response.ok || response.body === null) {
				activeTurns.delete(request.runId);
				return {
					status: "error",
					message: response.ok
						? "The Smithers web agent returned no response stream."
						: await errorDetail(response),
				};
			}
			void streamFrames(response.body, request.runId, publish, () =>
				activeTurns.delete(request.runId),
			)
				.catch((error: unknown) => {
					if (abortController.signal.aborted) return;
					publish({
						runId: request.runId,
						type: "done",
						error:
							error instanceof Error
								? error.message
								: "The Smithers web agent stream failed.",
					});
				})
				.finally(() => activeTurns.delete(request.runId));
			return { status: "started" };
		},
		cancelTurn: async (runId) => {
			const active = activeTurns.get(runId);
			if (active !== undefined) {
				active.abort();
				activeTurns.delete(runId);
			}
			await fetchImpl(`${baseUrl}${CANCEL_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ runId }),
			}).catch(() => {});
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
