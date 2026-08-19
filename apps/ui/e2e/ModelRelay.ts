/*
 * The hermetic e2e harness — the model relay double.
 *
 * The Worker's /api/model/stream forwards a sealed author call to
 * MODEL_RELAY_URL with the deployment key in x-api-key. Binding that var to
 * this double is what makes the relay exercisable without spending a real
 * provider credential, and `requests()` is what proves the key injection.
 */

export interface ModelRelayRequest {
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
}

export interface ModelRelay {
	readonly port: number;
	/** The value for MODEL_RELAY_URL. */
	readonly url: string;
	/** Arm the SSE lines this relay answers with. */
	readonly script: (lines: ReadonlyArray<string>) => void;
	readonly requests: () => ReadonlyArray<ModelRelayRequest>;
	readonly reset: () => void;
	readonly stop: () => void;
}

/** The value bound to MODEL_RELAY_API_KEY. */
export const MODEL_RELAY_KEY = "stub-model-relay-key";

/** One complete Anthropic-shaped message, start to stop. */
export const DEFAULT_RELAY_LINES: ReadonlyArray<string> = [
	"event: message_start",
	'data: {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"stub-model","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
	"",
	"event: content_block_start",
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from the stub relay."}}',
	"",
	"event: content_block_stop",
	'data: {"type":"content_block_stop","index":0}',
	"",
	"event: message_delta",
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}',
	"",
	"event: message_stop",
	'data: {"type":"message_stop"}',
	"",
];

export const createModelRelay = (): ModelRelay => {
	let lines: ReadonlyArray<string> = DEFAULT_RELAY_LINES;
	let recorded: Array<ModelRelayRequest> = [];

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const headers: Record<string, string> = {};
			for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
			const raw = await request.text();
			let body: unknown = raw;
			try {
				body = JSON.parse(raw);
			} catch {
				// A non-JSON body is recorded verbatim; the suite decides whether that matters.
			}
			recorded.push({ headers, body });
			return new Response(`${lines.join("\n")}\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
	});

	return {
		port: server.port ?? 0,
		url: `http://127.0.0.1:${server.port ?? 0}/v1/messages`,
		script: (next) => void (lines = next),
		requests: () => recorded,
		reset: () => {
			lines = DEFAULT_RELAY_LINES;
			recorded = [];
		},
		stop: () => void server.stop(true),
	};
};
