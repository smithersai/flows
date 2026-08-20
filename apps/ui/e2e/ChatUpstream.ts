/*
 * The hermetic e2e harness — the scriptable chat double.
 *
 * Stands in for chat.smithers.sh. The Worker's SMITHERS_CHAT_URL points here,
 * so a suite decides what the model says by arming a script rather than by
 * editing a shared mode enum. Frames are one JSON object per line with
 * content-type application/x-ndjson, exactly as the real upstream streams them.
 */

export interface ChatTurnScript {
	/** NDJSON frames, emitted in order with `gapMs` between them (default 10). */
	readonly frames: ReadonlyArray<Record<string, unknown>>;
	/**
	 * Frames computed from the request that asked for them. Wins over `frames`
	 * and is how a continuation turn quotes the tool output it just received.
	 */
	readonly framesFor?: (request: ChatRequest) => ReadonlyArray<Record<string, unknown>>;
	/**
	 * When true, a request that carries NO tool catalog answers HTTP 400. On
	 * the proxy wire the catalog is the `tools` array; on the sealed chain
	 * wire (RelayProtocol) tools never ride — the catalog is assembled into
	 * `instructions` — so a non-empty instructions block is the proof there.
	 */
	readonly requireTools?: boolean;
	readonly gapMs?: number;
	/** When set, the whole turn answers this HTTP status with `body` instead of streaming. */
	readonly status?: number;
	readonly body?: string;
}

export interface ChatMessage {
	readonly type?: string;
	readonly role?: string;
	readonly content?: unknown;
	readonly output?: string;
}

export interface ChatRequest {
	readonly messages: ReadonlyArray<ChatMessage>;
	readonly tools: ReadonlyArray<unknown>;
	/** The system prefix — on the sealed chain wire this is where the catalog rides. */
	readonly instructions: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface ChatUpstream {
	readonly port: number;
	/** The value for SMITHERS_CHAT_URL. */
	readonly url: string;
	/**
	 * Arm the turn scripts. Turn N uses scripts[N] while one exists, then the last
	 * one repeats — so a two-element array is exactly the tool-loop shape
	 * (tool_call, then the final text on the continuation).
	 */
	readonly script: (scripts: ChatTurnScript | ReadonlyArray<ChatTurnScript>) => void;
	/** Stream a `delta` every 250ms for 32 chunks, then `done:stop` — a killable turn. */
	readonly slow: () => void;
	/** Back to the default one-turn delta → card → done script; clears recorded requests. */
	readonly reset: () => void;
	readonly requests: () => ReadonlyArray<ChatRequest>;
	readonly stop: () => void;
}

/** The default script: one text delta, a status card, done. */
export const DEFAULT_CHAT_SCRIPT: ChatTurnScript = {
	frames: [
		{ type: "delta", kind: "text", text: "Hi, I'm Smithers (stub upstream)." },
		{
			type: "card",
			card: {
				id: "card-status",
				kind: "status",
				title: "Stub upstream",
				status: "active",
				createdAt: 1,
				ordinal: 1,
				payload: { progress: 1, note: "e2e" },
			},
		},
		{ type: "done" },
	],
};

/** The output the continuation turn carries back from the tool it called. */
export const toolOutputOf = (request: ChatRequest): string =>
	request.messages.find((message) => message.type === "function_call_output")?.output ?? "";

/**
 * One chain-authored turn: a fenced flow script, streamed as a single text
 * frame that settles with "stop" — the only shape the sealed author accepts
 * (Script.ts: exactly one ```flow block; ctx.call is the only door).
 */
export const flowScript = (body: string): ChatTurnScript => ({
	requireTools: true,
	frames: [
		{ type: "delta", kind: "text", text: "```flow\n" + body + "\n```" },
		{ type: "done", reason: "stop" },
	],
});

/**
 * The tool-loop script for one flow on the chain wire: one authored script
 * calls the flow and says the model's word about its result; a later turn
 * replaying this script (scripts repeat their last entry) only says the word,
 * proving repeated turns act exactly once.
 *
 * `finalText` receives the placeholder the script substitutes with the call's
 * own result at run time, so a sentence may quote the output it just got.
 */
export const toolLoopScript = (
	call: { readonly callId: string; readonly name: string; readonly args?: string },
	finalText: (toolOutput: string) => string,
): ReadonlyArray<ChatTurnScript> => [
	flowScript(
		[
			`const result = await ctx.call(${JSON.stringify(call.name)}, ${
				JSON.stringify(call.args === undefined ? {} : { args: call.args })
			})`,
			`const rendered = typeof result === "string" ? result : JSON.stringify(result ?? "")`,
			`await ctx.call("say", { text: ${JSON.stringify(finalText("__TOOL_OUTPUT__"))}.split("__TOOL_OUTPUT__").join(rendered) })`,
			`return done({ ok: true })`,
		].join("\n"),
	),
	flowScript(
		[
			`await ctx.call("say", { text: ${JSON.stringify(finalText(""))} })`,
			`return done({ ok: true })`,
		].join("\n"),
	),
];

const SLOW_SCRIPT: ChatTurnScript = {
	gapMs: 250,
	frames: [
		...Array.from({ length: 32 }, (_unused, index) => ({
			type: "delta",
			kind: "text",
			text: `chunk ${index} `,
		})),
		{ type: "done", reason: "stop" },
	],
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const createChatUpstream = (): ChatUpstream => {
	let scripts: ReadonlyArray<ChatTurnScript> = [DEFAULT_CHAT_SCRIPT];
	let turn = 0;
	let recorded: Array<ChatRequest> = [];

	const armed = (index: number): ChatTurnScript =>
		scripts[Math.min(index, scripts.length - 1)] ?? DEFAULT_CHAT_SCRIPT;

	const setScript = (next: ChatTurnScript | ReadonlyArray<ChatTurnScript>): void => {
		scripts = Array.isArray(next) ? (next as ReadonlyArray<ChatTurnScript>) : [next as ChatTurnScript];
		turn = 0;
	};

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/stub/reset" && request.method === "POST") {
				setScript(DEFAULT_CHAT_SCRIPT);
				recorded = [];
				return new Response('{"status":"ok"}', { status: 200 });
			}
			if (url.pathname === "/stub/requests" && request.method === "GET") {
				return Response.json(recorded);
			}
			if (!url.pathname.endsWith("/chat") || request.method !== "POST") {
				return new Response("not found", { status: 404 });
			}

			const raw = await request.text();
			let parsed: {
				messages?: ReadonlyArray<ChatMessage>;
				tools?: ReadonlyArray<unknown>;
				instructions?: string;
			} = {};
			try {
				parsed = JSON.parse(raw) as typeof parsed;
			} catch {
				// A non-JSON turn body is itself worth recording; the script decides what to do.
			}
			const headers: Record<string, string> = {};
			for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
			const record: ChatRequest = {
				messages: parsed.messages ?? [],
				tools: parsed.tools ?? [],
				instructions: typeof parsed.instructions === "string" ? parsed.instructions : "",
				headers,
			};
			recorded.push(record);

			const script = armed(turn);
			turn += 1;

			if (script.requireTools === true && record.tools.length === 0 && record.instructions === "") {
				return new Response("tool-loop turn arrived without a tool catalog", { status: 400 });
			}
			if (script.status !== undefined) {
				return new Response(script.body ?? "", { status: script.status });
			}

			const frames = script.framesFor?.(record) ?? script.frames;
			const gapMs = script.gapMs ?? 10;
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						try {
							for (const frame of frames) {
								if (request.signal.aborted) return;
								controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
								await wait(gapMs);
							}
							controller.close();
						} catch {
							// The Worker aborted the fetch mid-stream (a kill): the socket is gone.
						}
					},
				}),
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			);
		},
	});

	return {
		port: server.port ?? 0,
		url: `http://127.0.0.1:${server.port ?? 0}/chat`,
		script: setScript,
		slow: () => setScript(SLOW_SCRIPT),
		reset: () => {
			setScript(DEFAULT_CHAT_SCRIPT);
			recorded = [];
		},
		requests: () => recorded,
		stop: () => void server.stop(true),
	};
};
