/*
 * The native main process, run for real, with no window.
 *
 * apps/ui/src/bun/index.ts is a top-level-await module: importing it resolves
 * the main-view URL, registers the RPC surface and constructs the window as a
 * side effect, once per process. So it cannot be re-imported for a second
 * scenario, and `electrobun/bun` cannot be imported inside `bun test` at all —
 * it dlopens a native wrapper and installs a quit handler that keeps the
 * process alive.
 *
 * This driver is the way around both. It replaces `electrobun/bun` wholesale
 * with a recording fake, imports the REAL entrypoint, exercises the handlers
 * the entrypoint registered, and prints one JSON report on stdout.
 * src/bun/Main.test.ts spawns it once per scenario, which is how every
 * main-view URL branch is asserted against the shipped module rather than
 * against a copy of its logic.
 *
 * Nothing here fakes the product. The fake stands in for the HOST — the
 * window, the file dialog, the updater, the system browser — exactly the
 * parts a headless machine does not have.
 */
import { mock } from "bun:test";
import { PROBE_MARKER } from "./Probe.ts";
import type {
	NativeProbeReport,
	ProbeScenario,
	RecordedChatRequest,
	RecordedWindow,
} from "./Probe.ts";

const scenario: ProbeScenario = JSON.parse(process.env.SMITHERS_NATIVE_PROBE ?? "{}") as ProbeScenario;
const channel = scenario.channel ?? "dev";
const devServer = scenario.devServer ?? "down";
const dialogPaths = scenario.dialogPaths ?? [];
const openExternalAnswer = scenario.openExternalAnswer ?? true;
const agentStream = scenario.agentStream ?? null;

const logs: Array<string> = [];
const windows: Array<RecordedWindow> = [];
const webviewEvents: Array<string> = [];
const dialogOptions: Array<unknown> = [];
const openedExternally: Array<string> = [];
const chatRequests: Array<RecordedChatRequest> = [];
const frames: Array<unknown> = [];
const results: Record<string, unknown> = {};
let requestNames: ReadonlyArray<string> = [];
let messageNames: ReadonlyArray<string> = [];
let handlers: Record<string, unknown> = {};
let channelCalls = 0;
let devProbeCalls = 0;

const originalLog = console.log;
console.log = (...parts: ReadonlyArray<unknown>): void => {
	logs.push(parts.map((part) => String(part)).join(" "));
};

const fakeRpc = {
	proxy: {
		request: {},
		send: {
			agentFrame: (frame: unknown): void => {
				frames.push(frame);
			},
		},
	},
};

interface RpcConfig {
	readonly handlers: {
		readonly requests: Record<string, unknown>;
		readonly messages: Record<string, unknown>;
	};
}

mock.module("electrobun/bun", () => ({
	BrowserView: {
		defineRPC: (config: RpcConfig) => {
			requestNames = Object.keys(config.handlers.requests);
			messageNames = Object.keys(config.handlers.messages);
			handlers = config.handlers.requests;
			return fakeRpc;
		},
	},
	BrowserWindow: class FakeBrowserWindow {
		readonly webview = {
			on: (name: string): void => {
				webviewEvents.push(name);
			},
		};
		constructor(options: { title: unknown; url: unknown; frame: unknown; rpc: unknown }) {
			windows.push({
				title: options.title,
				url: options.url,
				frame: options.frame,
				rpcBound: options.rpc === fakeRpc,
			});
		}
	},
	Updater: {
		localInfo: {
			channel: async (): Promise<string> => {
				channelCalls += 1;
				return channel;
			},
		},
	},
	Utils: {
		openFileDialog: async (options: unknown): Promise<ReadonlyArray<string>> => {
			dialogOptions.push(options);
			return [...dialogPaths];
		},
		openExternal: (url: string): boolean => {
			openedExternally.push(url);
			return openExternalAnswer;
		},
	},
}));

const ndjson = (lines: ReadonlyArray<unknown>): Response =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
				controller.close();
			},
		}),
		{ status: 200 },
	);

/*
 * The two network calls the entrypoint makes are the dev-server probe and the
 * chat turn. Both are host facts, not product logic, so both are answered
 * here; anything else is a fault the report must surface rather than hide.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	if (url.startsWith("http://localhost:5173")) {
		devProbeCalls += 1;
		if (devServer === "up") return new Response(null, { status: 200 });
		throw new Error("connect ECONNREFUSED 127.0.0.1:5173");
	}
	const headers = new Headers(init?.headers);
	chatRequests.push({ url, runId: headers.get("x-smithers-run-id") });
	if (agentStream === null) throw new Error(`unexpected fetch: ${url}`);
	return ndjson(agentStream);
}) as typeof fetch;

await import("../../src/bun/index.ts");

for (const exercise of scenario.exercises ?? []) {
	const handler = handlers[exercise.request];
	if (typeof handler !== "function") {
		results[exercise.label] = { probeError: `no handler named ${exercise.request}` };
		continue;
	}
	results[exercise.label] = await (handler as (params: unknown) => unknown)(exercise.params);
}

if (scenario.settleMs !== undefined && scenario.settleMs > 0) {
	await new Promise((resolve) => setTimeout(resolve, scenario.settleMs));
}

globalThis.fetch = realFetch;
console.log = originalLog;

const report: NativeProbeReport = {
	logs,
	windows,
	requestNames,
	messageNames,
	webviewEvents,
	channelCalls,
	devProbeCalls,
	dialogOptions,
	openedExternally,
	chatRequests,
	frames,
	results,
};
await Bun.write(Bun.stdout, `${PROBE_MARKER}${JSON.stringify(report)}\n`);
process.exit(0);
