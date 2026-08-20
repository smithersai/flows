import type { IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { createCloudAgent } from "../bun/CloudAgent";
import { AgentRuntimeContextSchema } from "smithers-shared/AgentContext";
import { CANCEL_PATH, TOOLS_BROWSER_FETCH_PATH, TURN_PATH } from "smithers-shared/AgentApiRoutes";
import { browserFetch, browserFetchResponseBody } from "smithers-shared/BrowserFetch";
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent";

/*
 * Same-origin server boundary for pure-web Smithers chat. The browser posts a turn to
 * `/api/agent/turn` and reads back the exact NDJSON `AgentTurnFrame` stream the native
 * Electrobun app renders, so both clients share one contract. The upstream
 * chat.smithers.sh URL and origin (and any future credentials) stay on this side via
 * SMITHERS_CHAT_URL / SMITHERS_CHAT_ORIGIN; the browser never sees them.
 */

/** Long conversations are replayed on every turn, so the cap is generous, not tight. */
const MAX_BODY_BYTES = 1024 * 1024;

type Middleware = (req: IncomingMessage, res: ServerResponse) => void;

/** The connect-style app both the dev server and the preview server expose. */
export interface MiddlewareHost {
	readonly use: (path: string, handler: Middleware) => unknown;
}

class BodyTooLargeError extends Error {
	constructor() {
		super("Request body is too large.");
	}
}

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		let settled = false;
		const cleanup = (): void => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onAborted);
		};
		const finish = (result: { readonly value: unknown } | { readonly error: Error }): void => {
			if (settled) return;
			settled = true;
			cleanup();
			"error" in result ? reject(result.error) : resolve(result.value);
		};
		const onData = (chunk: Buffer): void => {
			if (overflowed) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				// Drain instead of destroying the socket so the caller can still answer 413.
				overflowed = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = (): void => {
			if (overflowed) {
				finish({ error: new BodyTooLargeError() });
				return;
			}
			try {
				finish({ value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			} catch {
				finish({ error: new Error("Request body must be valid JSON.") });
			}
		};
		const onError = (error: Error): void => finish({ error });
		const onAborted = (): void => finish({ error: new Error("Request body was aborted.") });
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onAborted);
	});

const isStartTurnRequest = (value: unknown): value is StartAgentTurnRequest =>
	typeof value === "object" &&
	value !== null &&
	"runId" in value &&
	typeof value.runId === "string" &&
	value.runId !== "" &&
	"messages" in value &&
	Array.isArray(value.messages) &&
	"instructions" in value &&
	typeof value.instructions === "string" &&
	// The tool specs are optional, but a non-array would be forwarded upstream as
	// a bogus `tools` field — same guard the product Worker applies.
	(!("tools" in value) || value.tools === undefined || Array.isArray(value.tools)) &&
	// The hidden runtime context is optional, but when it rides the wire it must
	// be the versioned structured contract — never an arbitrary blob.
	(!("context" in value) ||
		value.context === undefined ||
		AgentRuntimeContextSchema.safeParse(value.context).success);

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
	if (res.writableEnded) return;
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
};

const sendBadRequest = (res: ServerResponse, error: unknown): void =>
	sendJson(res, error instanceof BodyTooLargeError ? 413 : 400, {
		status: "error",
		message: error instanceof Error ? error.message : "Invalid request.",
	});

export interface AgentApiOptions {
	readonly chatUrl?: string;
	readonly origin?: string;
}

/**
 * A live turn's open NDJSON response. `end` is idempotent so a client disconnect, a
 * cancel request, and a terminal `done` frame can all race without double-ending.
 */
interface TurnWriter {
	readonly write: (frame: AgentTurnFrame) => void;
	readonly end: () => void;
}

export const installAgentApi = (host: MiddlewareHost, options: AgentApiOptions = {}): void => {
	const writers = new Map<string, TurnWriter>();
	const agent = createCloudAgent((frame) => writers.get(frame.runId)?.write(frame), {
		chatUrl: options.chatUrl,
		origin: options.origin,
	});

	const finish = (runId: string, writer: TurnWriter): void => {
		if (writers.get(runId) === writer) writers.delete(runId);
		writer.end();
	};

	// Registered first so connect's prefix match does not route cancels to the turn handler.
	host.use(CANCEL_PATH, (req, res) => {
		if (req.method !== "POST") {
			sendJson(res, 405, { status: "error", message: "Method not allowed." });
			return;
		}
		void readJsonBody(req)
			.then((body) => {
				const runId =
					typeof body === "object" && body !== null && "runId" in body ? body.runId : undefined;
				if (typeof runId !== "string" || runId === "") {
					sendJson(res, 400, { status: "error", message: "runId is required." });
					return;
				}
				const result = agent.cancel(runId);
				// Cancelling aborts upstream without emitting a frame, so close the stream here
				// or the browser would keep reading a response that can never complete.
				const writer = writers.get(runId);
				if (writer !== undefined) finish(runId, writer);
				sendJson(res, 200, result);
			})
			.catch((error: unknown) => sendBadRequest(res, error));
	});

	// The browser tool's guarded fetch (Wave 10, §2d) — the same shared
	// handler the deployed Worker runs, with node:dns as the resolver.
	host.use(TOOLS_BROWSER_FETCH_PATH, (req, res) => {
		if (req.method !== "POST") {
			sendJson(res, 405, { status: "error", message: "Method not allowed." });
			return;
		}
		void readJsonBody(req)
			.then(async (body) => {
				const url =
					typeof body === "object" && body !== null && "url" in body && typeof body.url === "string"
						? body.url
						: undefined;
				if (url === undefined || url.trim() === "") {
					sendJson(res, 400, { status: "error", message: "Body must be { url }." });
					return;
				}
				const outcome = await browserFetch(url.trim(), {
					resolveHost: async (hostname) =>
						(await lookup(hostname, { all: true })).map((record) => record.address),
				});
				sendJson(res, outcome.ok ? 200 : 422, browserFetchResponseBody(outcome));
			})
			.catch((error: unknown) => sendBadRequest(res, error));
	});

	host.use(TURN_PATH, (req, res) => {
		if (req.method !== "POST") {
			sendJson(res, 405, { status: "error", message: "Method not allowed." });
			return;
		}
		void readJsonBody(req)
			.then((body) => {
				if (!isStartTurnRequest(body)) {
					sendJson(res, 400, {
						status: "error",
						message:
							"Body must be { runId, messages, instructions } with optional tools and context.",
					});
					return;
				}
				const runId = body.runId;
				const started = agent.start(body);
				if (started.status === "error") {
					sendJson(res, 409, started);
					return;
				}
				res.statusCode = 200;
				res.setHeader("content-type", "application/x-ndjson");
				res.setHeader("cache-control", "no-store");
				res.flushHeaders();
				const writer: TurnWriter = {
					write: (frame) => {
						if (res.writableEnded) return;
						res.write(`${JSON.stringify(frame)}\n`);
						if (frame.type === "done") finish(runId, writer);
					},
					end: () => {
						if (!res.writableEnded) res.end();
					},
				};
				writers.set(runId, writer);
				res.on("close", () => {
					// Only this response's own writer may cancel: a later turn reusing the runId
					// must survive this one's teardown.
					if (writers.get(runId) !== writer) return;
					writers.delete(runId);
					agent.cancel(runId);
				});
			})
			.catch((error: unknown) => sendBadRequest(res, error));
	});
};
