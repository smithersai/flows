/**
 * Scripted local end-to-end proof for the deployable server. Two boots of
 * `wrangler dev` against the TEST DOUBLES in scripts/stub-backends.ts:
 *
 *   Phase A (no backend seams configured): SPA + isolation headers, one
 *     streamed chat turn (delta → card → done), cancel semantics, and the
 *     honest 501s from every unconfigured seam (gateway, identity, billing,
 *     approvals).
 *   Phase B (all seams pointed at the doubles): the full auth journey
 *     (signed-out → sign-in → non-allowlisted → request-access → allowlisted
 *     → chat), the balance read in dollars draining to $0 with
 *     allowedToStartWork:false, the approval round trip (approve, deny,
 *     and forced-failure) asserting the Worker's identity injection, and the
 *     Wave 8 OAuth dead-end seam (a 503 upstream renders the branded honest
 *     page for browsers, keeps JSON for machines; the signed-out session
 *     probe resolves 200, never a console-error 401).
 *
 * Usage: bun scripts/worker-e2e.ts
 */
import { fileURLToPath } from "node:url";
import {
	createStubBilling,
	createStubGateway,
	createStubIdentity,
	createStubReco,
	STUB_ADMIN_TOKEN,
	STUB_BILLING_BEARER,
	STUB_PRODUCT_TOKEN,
} from "./stub-backends";
import { createAppController } from "../src/mainview/state/AppController";
import { createAppStore } from "../src/mainview/state/AppStore";
import { createWebAgent } from "../src/mainview/native/WebAgent";

const WORKER_PORT = 8790;
const WORKER_ORIGIN = `http://127.0.0.1:${WORKER_PORT}`;

/*
 * The Worker and its wrangler.jsonc live in the sibling `smithers-server`
 * package; the config's `main` and `assets.directory` are relative to it, so
 * `wrangler dev` must be spawned there.
 */
const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/*
 * `wrangler dev` rewrites request URLs to the route in wrangler.jsonc, so the
 * Worker's proxy states THAT origin (http://<route host>) to the siblings, not
 * localhost. The doubles list it as an allowed origin, exactly like the real
 * workers' ALLOWED_ORIGINS list the product Worker's origin. Derived from the
 * config so a route change cannot silently rebreak this.
 */
const DEV_PRESENTED_ORIGINS: ReadonlyArray<string> = await (async (): Promise<ReadonlyArray<string>> => {
	const config = await Bun.file(new URL("../../server/wrangler.jsonc", import.meta.url)).text();
	const host = /"pattern"\s*:\s*"([^"/]+)"/.exec(config)?.[1];
	return host === undefined ? [] : [`http://${host}`];
})();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let wrangler: ReturnType<typeof Bun.spawn> | undefined;
const cleanup = (): void => {
	wrangler?.kill();
	chatUpstream.stop(true);
	identity.stop();
	billing.stop();
	gateway.stop();
	reco.stop();
};
const fail = async (reason: string): Promise<never> => {
	console.error(`FAIL: ${reason}`);
	cleanup();
	process.exit(1);
};

// A stub chat.smithers.sh: emits one NDJSON turn (delta, card, done) per POST.
// In tool-loop mode (armed via /stub/arm-tool-loop) it plays the chat worker's
// tool contract: a turn without a tool result gets a tool_call frame + done,
// the continuation turn gets the final text — and any tool-loop request that
// arrives WITHOUT the tools spec fails, proving the Worker forwards them.
// In slow mode (armed via /stub/arm-slow) it streams a delta every 250ms for
// ~8s so a server-side kill can land mid-flight; /stub/arm-default resets.
let chatMode: "default" | "tool-loop" | "tool-loop-repos" | "tool-loop-workflow-lie" | "slow" = "default";
/*
 * Wave 12 §1: the EXACT turn canary produced — a workflow.create tool call
 * followed by prose claiming the workflow "has been created and is now
 * running", with an invented name. Replaying it through the real client is the
 * truth test: the rendered turn must not carry the lie.
 */
const WAVE11_CANARY_LIE =
	'The workflow "summarize-open-issues" has been created and is now running on your workspace.';
const chatUpstream = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/stub/arm-tool-loop" && request.method === "POST") {
			chatMode = "tool-loop";
			return new Response('{"status":"ok"}', { status: 200 });
		}
		if (url.pathname === "/stub/arm-tool-loop-repos" && request.method === "POST") {
			chatMode = "tool-loop-repos";
			return new Response('{"status":"ok"}', { status: 200 });
		}
		if (url.pathname === "/stub/arm-tool-loop-workflow-lie" && request.method === "POST") {
			chatMode = "tool-loop-workflow-lie";
			return new Response('{"status":"ok"}', { status: 200 });
		}
		if (url.pathname === "/stub/arm-slow" && request.method === "POST") {
			chatMode = "slow";
			return new Response('{"status":"ok"}', { status: 200 });
		}
		if (url.pathname === "/stub/arm-default" && request.method === "POST") {
			chatMode = "default";
			return new Response('{"status":"ok"}', { status: 200 });
		}
		if (!url.pathname.endsWith("/chat")) return new Response("not found", { status: 404 });
		const encoder = new TextEncoder();
		if (chatMode === "slow") {
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						try {
							for (let index = 0; index < 32; index += 1) {
								if (request.signal.aborted) return;
								controller.enqueue(
									encoder.encode(
										`${JSON.stringify({ type: "delta", kind: "text", text: `chunk ${index} ` })}\n`,
									),
								);
								await wait(250);
							}
							controller.enqueue(
								encoder.encode(`${JSON.stringify({ type: "done", reason: "stop" })}\n`),
							);
							controller.close();
						} catch {
							// The Worker aborted the fetch mid-stream (a kill): the socket is gone.
						}
					},
				}),
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			);
		}
		let frames: Array<Record<string, unknown>>;
		if (chatMode === "tool-loop-workflow-lie") {
			const body = (await request.json()) as {
				messages?: Array<{ type?: string; output?: string }>;
				tools?: Array<unknown>;
			};
			if (!Array.isArray(body.tools) || body.tools.length === 0) {
				return new Response("tool-loop turn arrived without tools", { status: 400 });
			}
			const toolResult = body.messages?.find((message) => message.type === "function_call_output");
			frames =
				toolResult === undefined
					? [
							{
								type: "tool_call",
								call_id: "e2e-call-workflow",
								name: "commands",
								arguments: JSON.stringify({
									action: "execute",
									name: "workflow.create",
									args: "a workflow that summarizes my open issues will/flows",
								}),
							},
							{ type: "done", reason: "tool_call" },
						]
					: [
							{ type: "delta", kind: "text", text: WAVE11_CANARY_LIE },
							{ type: "done", reason: "stop" },
						];
		} else if (chatMode === "tool-loop-repos") {
			const body = (await request.json()) as {
				messages?: Array<{ type?: string; output?: string }>;
				tools?: Array<unknown>;
			};
			if (!Array.isArray(body.tools) || body.tools.length === 0) {
				return new Response("tool-loop turn arrived without tools", { status: 400 });
			}
			const toolResult = body.messages?.find((message) => message.type === "function_call_output");
			frames =
				toolResult === undefined
					? [
							{
								type: "tool_call",
								call_id: "e2e-call-repos",
								name: "commands",
								arguments: JSON.stringify({ action: "execute", name: "repos.watch", args: "will/smithers" }),
							},
							{ type: "done", reason: "tool_call" },
						]
					: [
							{
								type: "delta",
								kind: "text",
								text: `Done — the tool answered "${toolResult.output ?? ""}", so the chooser is open.`,
							},
							{ type: "done", reason: "stop" },
						];
		} else if (chatMode === "tool-loop") {
			const body = (await request.json()) as {
				messages?: Array<{ type?: string; output?: string }>;
				tools?: Array<unknown>;
			};
			if (!Array.isArray(body.tools) || body.tools.length === 0) {
				return new Response("tool-loop turn arrived without tools", { status: 400 });
			}
			const toolResult = body.messages?.find((message) => message.type === "function_call_output");
			frames =
				toolResult === undefined
					? [
							{
								type: "tool_call",
								call_id: "e2e-call-1",
								name: "commands",
								arguments: JSON.stringify({ action: "execute", name: "world.new-note" }),
							},
							{ type: "done", reason: "tool_call" },
						]
					: [
							{
								type: "delta",
								kind: "text",
								text: `Done — the tool answered "${toolResult.output ?? ""}", so the note exists now.`,
							},
							{ type: "done", reason: "stop" },
						];
		} else {
			frames = [
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
			];
		}
		return new Response(
			new ReadableStream<Uint8Array>({
				async start(controller) {
					for (const frame of frames) {
						controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
						await wait(10);
					}
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "application/x-ndjson" } },
		);
	},
});

const identity = createStubIdentity(DEV_PRESENTED_ORIGINS);
const billing = createStubBilling(DEV_PRESENTED_ORIGINS);
const gateway = createStubGateway();
const reco = createStubReco(DEV_PRESENTED_ORIGINS);

const bootWorker = async (vars: Record<string, string>): Promise<void> => {
	// wrangler dev auto-loads .dev.vars (the live dev stack's seam URLs). Phase
	// A's premise is "no backend seams configured", so every seam var the file
	// might set is explicitly overridden — an empty value reads as unset.
	const sealed: Record<string, string> = {
		IDENTITY_UPSTREAM_URL: "",
		IDENTITY_SERVICE_TOKEN: "",
		IDENTITY_ADMIN_TOKEN: "",
		BILLING_UPSTREAM_URL: "",
		BILLING_AUTH_TOKEN: "",
		BILLING_PRODUCT_SERVICE_TOKEN: "",
		BILLING_ADMIN_TOKEN: "",
		CHAT_PRODUCT_SERVICE_TOKEN: "",
		RECO_UPSTREAM_URL: "",
		RECO_ADMIN_TOKEN: "",
		GATEWAY_UPSTREAM_URL: "",
		GATEWAY_AUTH_TOKEN: "",
		GATEWAY_SESSION_USER_ID: "",
		SMITHERS_CHAT_AUTH_TOKEN: "",
		...vars,
	};
	wrangler = Bun.spawn(
		[
			"bun",
			"x",
			"wrangler",
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			String(WORKER_PORT),
			...Object.entries(sealed).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
		],
		{ cwd: SERVER_DIR, stdout: "inherit", stderr: "inherit" },
	);
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(WORKER_ORIGIN);
			if (response.ok) return;
		} catch {
			// wrangler is still starting.
		}
		await wait(500);
	}
	await fail("wrangler dev never came up.");
};

const stopWorker = async (): Promise<void> => {
	wrangler?.kill();
	wrangler = undefined;
	await wait(750);
};

console.log("building the SPA (vite build)...");
const build = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
if ((await build.exited) !== 0) {
	cleanup();
	process.exit(1);
}

/* ---------------- Phase A: no backend seams configured ---------------- */

console.log("phase A: wrangler dev with no identity/billing/gateway upstreams...");
await bootWorker({ SMITHERS_CHAT_URL: `http://127.0.0.1:${chatUpstream.port}/chat` });

const page = await fetch(WORKER_ORIGIN);
const html = await page.text();
if (!html.includes("<")) await fail("the root page did not look like HTML.");
for (const header of ["cross-origin-opener-policy", "cross-origin-embedder-policy"]) {
	if (page.headers.get(header) === null) await fail(`missing ${header} on the SPA response.`);
}
console.log("ok: SPA served with COOP/COEP headers.");

const turn = await fetch(`${WORKER_ORIGIN}/api/agent/turn`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		runId: "e2e-run-1",
		messages: [{ role: "user", content: "Hello who are you" }],
		instructions: "Be brief.",
	}),
});
if (turn.status !== 200) await fail(`/api/agent/turn answered HTTP ${turn.status}: ${await turn.text()}`);
if (turn.headers.get("content-type") !== "application/x-ndjson") {
	await fail(`unexpected content-type: ${turn.headers.get("content-type")}`);
}
const lines = (await turn.text())
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as { type: string });
const kinds = lines.map((line) => line.type);
if (kinds[0] !== "delta" || !kinds.includes("card") || kinds[kinds.length - 1] !== "done") {
	await fail(`the streamed turn did not carry delta → card → done frames (saw ${kinds.join(",")}).`);
}
console.log(`ok: one streamed chat turn completed through /api/agent/turn (${kinds.join(" → ")}).`);

const cancel = await fetch(`${WORKER_ORIGIN}/api/agent/turn/cancel`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ runId: "e2e-run-1" }),
});
if (cancel.status !== 200) await fail(`/api/agent/turn/cancel answered HTTP ${cancel.status}`);
console.log("ok: cancel endpoint answered.");

/* ----- Wave 6c (B-3): the server-side kill, mid-stream, over real HTTP ----- */

// A slow turn streams for ~8s; the kill lands mid-flight through the cancel
// route and the turn's own stream must end with the honest terminal frame —
// never a silent stop, never a 500, and never done:stop after a kill.
const armSlow = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-slow`, { method: "POST" });
if (armSlow.status !== 200) await fail("the stub arm-slow control failed.");
const slowTurn = await fetch(`${WORKER_ORIGIN}/api/agent/turn`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		runId: "e2e-run-kill",
		messages: [{ role: "user", content: "take your time" }],
		instructions: "Be brief.",
	}),
});
if (slowTurn.status !== 200) await fail(`the slow turn answered HTTP ${slowTurn.status}.`);
const slowReader = slowTurn.body!.getReader();
const slowDecoder = new TextDecoder();
let slowBuffer = "";
const readSlowFrame = async (): Promise<Record<string, unknown>> => {
	for (;;) {
		const newline = slowBuffer.indexOf("\n");
		if (newline >= 0) {
			const line = slowBuffer.slice(0, newline);
			slowBuffer = slowBuffer.slice(newline + 1);
			if (line.trim() !== "") return JSON.parse(line) as Record<string, unknown>;
			continue;
		}
		const { value, done } = await slowReader.read();
		if (done) throw new Error("the slow stream ended before the next frame");
		slowBuffer += slowDecoder.decode(value, { stream: true });
	}
};
const firstSlow = await readSlowFrame();
if (firstSlow.type !== "delta") await fail(`the slow turn did not start streaming (saw ${firstSlow.type}).`);
const midKill = await fetch(`${WORKER_ORIGIN}/api/agent/turn/cancel`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ runId: "e2e-run-kill" }),
});
if (midKill.status !== 200) await fail(`the mid-stream kill answered HTTP ${midKill.status}.`);
const midKillBody = (await midKill.json()) as { status?: string };
if (midKillBody.status !== "cancelled") {
	await fail(`the mid-stream kill did not report cancelled: ${JSON.stringify(midKillBody)}.`);
}
let terminal: Record<string, unknown> | undefined;
for (let seen = 0; seen < 40; seen += 1) {
	const frame = await readSlowFrame().catch(() => undefined);
	if (frame === undefined) break;
	if (frame.type === "done") {
		terminal = frame;
		break;
	}
}
if (terminal?.reason !== "cancelled") {
	await fail(`the killed turn did not end with the honest cancelled frame (saw ${JSON.stringify(terminal)}).`);
}
// A second kill on the now-settled turn is the honest not-found, never an error.
const lateKill = await fetch(`${WORKER_ORIGIN}/api/agent/turn/cancel`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ runId: "e2e-run-kill" }),
});
const lateKillBody = (await lateKill.json()) as { status?: string };
if (lateKill.status !== 200 || lateKillBody.status !== "not-found") {
	await fail(`killing the settled turn did not answer not-found: HTTP ${lateKill.status} ${JSON.stringify(lateKillBody)}.`);
}
console.log(
	"ok: server-side kill mid-stream — cancel answered cancelled, the stream ended with done:cancelled (never done:stop), and a late kill is not-found.",
);
const armDefault = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-default`, { method: "POST" });
if (armDefault.status !== 200) await fail("the stub arm-default control failed.");

const seam501 = async (path: string, envName: string, init?: RequestInit): Promise<void> => {
	const response = await fetch(`${WORKER_ORIGIN}${path}`, init);
	if (response.status !== 501) await fail(`${path} answered HTTP ${response.status}, expected 501.`);
	const body = (await response.json()) as { message?: string };
	if (body.message?.includes(envName) !== true) {
		await fail(`${path}'s 501 was not honest about the missing ${envName}.`);
	}
};
await seam501("/v1/rpc/getRun", "GATEWAY_UPSTREAM_URL", { method: "POST", body: "{}" });
console.log("ok: gateway seam 501s honestly with no upstream configured.");
await seam501("/api/auth/session", "IDENTITY_UPSTREAM_URL");
await seam501("/api/identity/request-access", "IDENTITY_UPSTREAM_URL", { method: "POST", body: "{}" });
console.log("ok: identity seam 501s honestly with no upstream configured.");
await seam501("/api/billing/balance", "BILLING_UPSTREAM_URL");
console.log("ok: billing seam 501s honestly with no upstream configured.");
await seam501("/api/approvals/decision", "GATEWAY_UPSTREAM_URL", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ runId: "r", nodeId: "n", iteration: 0, decision: { approved: true } }),
});
console.log("ok: approvals route 501s honestly with no gateway configured.");
await seam501("/api/reco/first-run", "RECO_UPSTREAM_URL");
console.log("ok: reco seam 501s honestly with no upstream configured.");

// The admin surface is non-enumerable: signed-out probes get the canonical
// 404, byte-identical to any unknown /api/* route.
const unknownRoute = await fetch(`${WORKER_ORIGIN}/api/definitely-not-a-route`);
if (unknownRoute.status !== 404) await fail(`an unknown /api route answered HTTP ${unknownRoute.status}.`);
const unknownBody = await unknownRoute.text();
for (const path of ["/api/admin/requests", "/api/admin/health", "/api/admin/feedback"]) {
	const probe = await fetch(`${WORKER_ORIGIN}${path}`);
	if (probe.status !== 404 || (await probe.text()) !== unknownBody) {
		await fail(`${path} was enumerable (HTTP ${probe.status} or a different body than an unknown route).`);
	}
}
console.log("ok: the admin surface answers signed-out probes byte-identically to an unknown route (404, never 403).");

// A cross-site page must not be able to drive routes that spend this
// deployment's own credentials. A simple-content-type POST is not preflighted,
// so the Worker's own same-origin guard is the only thing standing there.
for (const [path, init] of [
	["/api/approvals/decision", { method: "POST", body: "{}" }],
	["/api/agent/turn", { method: "POST", body: "{}" }],
	["/api/billing/balance", {}],
] as const) {
	const crossOrigin = await fetch(`${WORKER_ORIGIN}${path}`, {
		...init,
		headers: { "content-type": "text/plain", origin: "https://evil.example" },
	});
	if (crossOrigin.status !== 403) {
		await fail(`${path} answered a cross-origin request with HTTP ${crossOrigin.status}, expected 403.`);
	}
}
console.log("ok: cross-origin requests to the API are refused (403) before any credential is spent.");

await stopWorker();

/* ------------- Phase B: all seams pointed at the test doubles ------------- */

console.log("phase B: wrangler dev against the stub identity/billing/gateway/reco...");
await bootWorker({
	SMITHERS_CHAT_URL: `http://127.0.0.1:${chatUpstream.port}/chat`,
	IDENTITY_UPSTREAM_URL: `http://127.0.0.1:${identity.port}`,
	IDENTITY_SERVICE_TOKEN: "stub-service-token",
	BILLING_UPSTREAM_URL: `http://127.0.0.1:${billing.port}`,
	BILLING_AUTH_TOKEN: STUB_BILLING_BEARER,
	BILLING_PRODUCT_SERVICE_TOKEN: STUB_PRODUCT_TOKEN,
	GATEWAY_UPSTREAM_URL: `http://127.0.0.1:${gateway.port}`,
	GATEWAY_SESSION_USER_ID: "will",
	// Wave 11: the per-user relay. The same double serves the Cloud provision
	// route and the per-gateway surface it hands back.
	SMITHERS_CLOUD_API_BASE_URL: `http://127.0.0.1:${gateway.port}`,
	RECO_UPSTREAM_URL: `http://127.0.0.1:${reco.port}`,
	IDENTITY_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
	BILLING_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
	RECO_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
});

// The auth journey: signed-out → sign-in → non-allowlisted → request-access → allowlisted → chat.
const scopes = await fetch(`${WORKER_ORIGIN}/api/auth/scopes`);
if (scopes.status !== 200) await fail(`/api/auth/scopes answered HTTP ${scopes.status}.`);
const scopesBody = (await scopes.json()) as { scopes?: Array<{ plain: string }> };
if (!Array.isArray(scopesBody.scopes) || scopesBody.scopes.length === 0) {
	await fail("the scopes route did not return a plain-words scope list.");
}

const anon = await fetch(`${WORKER_ORIGIN}/api/auth/session`);
const anonBody = (await anon.json()) as { status?: string };
// Wave 8: the seam restates the expected signed-out 401 as a resolved 200 —
// the browser logs any 4xx as a console error even when the client handles it.
if (anon.status !== 200 || anonBody.status !== "signed-out") {
	await fail(`a signed-out session check answered HTTP ${anon.status} ${JSON.stringify(anonBody)}, expected 200 signed-out.`);
}

/* ----- Wave 8: no dead ends on the OAuth navigation routes ----- */

// With the identity upstream answering 503 (OAuth unconfigured, exactly like
// the live deployment), a browser navigation must land on the branded honest
// page — never raw JSON — while a machine caller keeps the JSON, status intact.
const oauthDown = await fetch(`http://127.0.0.1:${identity.port}/stub/oauth-down`, { method: "POST" });
if (oauthDown.status !== 200) await fail("the stub oauth-down control failed.");
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
for (const [path, code, heading] of [
	["/api/auth/github/start", "oauth_not_configured", "isn't switched on yet"],
	["/api/auth/github/callback?code=stub-code&state=stub-state", "oauth_callback_failed", "didn't finish"],
] as const) {
	const page = await fetch(`${WORKER_ORIGIN}${path}`, {
		headers: { accept: BROWSER_ACCEPT },
		redirect: "manual",
	});
	const pageBody = await page.text();
	if (page.status !== 503) await fail(`${path} answered HTTP ${page.status} for a browser, expected the honest 503 page.`);
	if (page.headers.get("content-type")?.includes("text/html") !== true) {
		await fail(`${path} did not answer HTML for a browser (content-type ${page.headers.get("content-type")}).`);
	}
	if (!pageBody.includes('href="/"')) await fail(`${path}'s honest page offers no way back home.`);
	if (!pageBody.includes(heading)) await fail(`${path}'s page did not state honestly what happened (missing "${heading}").`);
	const machine = await fetch(`${WORKER_ORIGIN}${path}`, {
		headers: { accept: "application/json" },
		redirect: "manual",
	});
	const machineBody = (await machine.json()) as { code?: string };
	if (machine.status !== 503 || machineBody.code !== code) {
		await fail(`${path} did not keep the machine-readable answer for Accept: application/json (HTTP ${machine.status} ${JSON.stringify(machineBody)}).`);
	}
}
console.log(
	"ok: OAuth navigation errors render the branded honest page with the way home for browsers, and keep the JSON + status for Accept: application/json.",
);
const oauthUp = await fetch(`http://127.0.0.1:${identity.port}/stub/oauth-up`, { method: "POST" });
if (oauthUp.status !== 200) await fail("the stub oauth-up control failed.");

const start = await fetch(`${WORKER_ORIGIN}/api/auth/github/start`, { redirect: "manual" });
const startLocation = start.headers.get("location");
if (start.status !== 302 || startLocation === null) {
	await fail(`the sign-in start did not redirect (HTTP ${start.status}).`);
}
const callback = await fetch(`${WORKER_ORIGIN}${startLocation}`, { redirect: "manual" });
const setCookie = callback.headers.get("set-cookie");
if (callback.status !== 302 || setCookie === null || !setCookie.includes("stub_session=")) {
	await fail("the sign-in callback did not issue a session cookie.");
}
const cookie = setCookie.split(";")[0] ?? "";

const session1 = await fetch(`${WORKER_ORIGIN}/api/auth/session`, { headers: { cookie } });
const session1Body = (await session1.json()) as { login?: string; allowlisted?: boolean };
if (session1.status !== 200 || session1Body.login !== "will" || session1Body.allowlisted !== false) {
	await fail(`the signed-in session was not the non-allowlisted stub user: ${JSON.stringify(session1Body)}.`);
}

const requestAccess = await fetch(`${WORKER_ORIGIN}/api/identity/request-access`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify({ login: "will" }),
});
if (requestAccess.status !== 200) await fail(`request-access answered HTTP ${requestAccess.status}.`);
const requestAccessAgain = await fetch(`${WORKER_ORIGIN}/api/identity/request-access`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify({ login: "will" }),
});
if (requestAccessAgain.status !== 200) {
	await fail(`request-access was not idempotent (second POST HTTP ${requestAccessAgain.status}).`);
}

/* ---- Wave 9: auth states are conversation states in the real client ---- */

const noNativeRepos = {
	available: false,
	pickLocalRepository: async () => ({
		status: "error" as const,
		code: "native-required",
		message: "no native bridge in the e2e",
	}),
};
const e2eMemoryStorage = (): import("@tanstack/db").StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};

// Signed-out: the chat IS the page — an attempted send resolves to the calm
// one-line sign-in reply riding an action, and never reaches the turn route.
{
	let turnPosts = 0;
	const pristine = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const request = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
		if (new URL(request.url).pathname === "/api/agent/turn" && request.method === "POST") turnPosts += 1;
		return pristine(request);
	}) as typeof fetch;
	try {
		const store = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
		const controller = createAppController(
			store,
			noNativeRepos,
			createWebAgent({ baseUrl: WORKER_ORIGIN }),
			{ baseUrl: WORKER_ORIGIN },
		);
		await controller.loadSession();
		if (store.collections.identitySessions.get("identity")?.state !== "signed-out") {
			await fail("the real client did not record the signed-out answer.");
		}
		controller.send("hello — is anyone there?");
		await wait(300);
		const reply = [...store.collections.messages.values()].find(
			(message) => message.action?.command === "auth.sign-in",
		);
		if (turnPosts !== 0) await fail("a signed-out send reached the turn route.");
		if (reply === undefined || !reply.text.includes("Sign in with GitHub first")) {
			await fail("a signed-out send did not resolve to the calm sign-in reply.");
		}
		if (store.session().phase !== "idle") await fail("a signed-out send left the composer busy.");
	} finally {
		globalThis.fetch = pristine;
	}
}
console.log("ok: signed-out chat — attempted send resolves to the calm sign-in reply with the action; no turn POST.");

// Signed-in but not allowlisted: request access goes through the chat's
// command, and an attempted send states the honest waiting state.
{
	const pristine = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
		if (new URL(base.url).origin !== WORKER_ORIGIN || base.headers.has("cookie")) return pristine(base);
		const headers = new Headers(base.headers);
		headers.set("cookie", cookie);
		return pristine(new Request(base, { headers }));
	}) as typeof fetch;
	try {
		const store = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
		const controller = createAppController(
			store,
			noNativeRepos,
			createWebAgent({ baseUrl: WORKER_ORIGIN }),
			{ baseUrl: WORKER_ORIGIN },
		);
		await controller.loadSession();
		const identity = store.collections.identitySessions.get("identity");
		if (identity?.state !== "signed-in" || identity.allowlisted) {
			await fail("the real client did not record the non-allowlisted answer.");
		}
		if (!controller.runCommand("auth.request-access")) await fail("auth.request-access is not registered.");
		await wait(300);
		if (store.collections.identitySessions.get("identity")?.accessRequested !== true) {
			await fail("request access through the chat did not confirm.");
		}
		controller.send("hello?");
		await wait(300);
		const reply = [...store.collections.messages.values()].find((message) =>
			message.text.includes("Your request is already in"),
		);
		if (reply === undefined) await fail("a non-allowlisted send did not state the honest waiting state.");
	} finally {
		globalThis.fetch = pristine;
	}
}
console.log("ok: non-allowlisted chat — request access via the chat's command; attempted send states the waiting state.");

// Returning from a failed OAuth redirect: a Smithers message in the chat with
// a retry sign-in action — never a bare page.
{
	const store = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
	const controller = createAppController(
		store,
		noNativeRepos,
		createWebAgent({ baseUrl: WORKER_ORIGIN }),
		{ baseUrl: WORKER_ORIGIN },
	);
	if (!controller.handleAuthReturn("?auth=failed")) {
		await fail("the failed-OAuth return was not recognized.");
	}
	const message = [...store.collections.messages.values()].find((entry) =>
		entry.text.includes("GitHub sign-in didn't finish"),
	);
	if (message === undefined || message.action?.command !== "auth.sign-in") {
		await fail("the failed-OAuth return did not render as a chat message with the retry action.");
	}
	if (controller.handleAuthReturn("?")) await fail("a clean boot was mistaken for a failed OAuth return.");
}
console.log("ok: failed-OAuth return — honest chat message with the retry sign-in action, never a bare page.");

// The admin act: the login joins the allowlist (test control on the stub itself).
const allow = await fetch(`http://127.0.0.1:${identity.port}/stub/allowlist`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ login: "will" }),
});
if (allow.status !== 200) await fail("the stub allowlist control failed.");

const session2 = await fetch(`${WORKER_ORIGIN}/api/auth/session`, { headers: { cookie } });
const session2Body = (await session2.json()) as { allowlisted?: boolean };
if (session2.status !== 200 || session2Body.allowlisted !== true) {
	await fail(`the session did not turn allowlisted after the admin act: ${JSON.stringify(session2Body)}.`);
}

// Allowlisted → chat: a streamed turn completes through the same worker.
const journeyTurn = await fetch(`${WORKER_ORIGIN}/api/agent/turn`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify({
		runId: "e2e-run-2",
		messages: [{ role: "user", content: "I'm in — hello" }],
		instructions: "Be brief.",
	}),
});
if (journeyTurn.status !== 200) await fail(`the allowlisted chat turn answered HTTP ${journeyTurn.status}.`);
await journeyTurn.text();
console.log(
	"ok: auth journey through the stub identity upstream (signed-out → sign-in → non-allowlisted → request-access → allowlisted → chat).",
);

// Balance in dollars, then drain to $0.
const balance1 = await fetch(`${WORKER_ORIGIN}/api/billing/balance`, { headers: { cookie } });
if (balance1.status !== 200) await fail(`/api/billing/balance answered HTTP ${balance1.status}.`);
const balance1Body = (await balance1.json()) as {
	balance?: { totalUsd?: string };
	state?: string;
	allowedToStartWork?: boolean;
};
if (balance1Body.balance?.totalUsd !== "500" || balance1Body.allowedToStartWork !== true) {
	await fail(`the balance did not read $500 with work allowed: ${JSON.stringify(balance1Body)}.`);
}
// Wave 13: the signed-in read billed AS THE USER — the trusted-caller path
// (service token + validated login), never the deployment-wide bearer.
const lastAuth = await fetch(`http://127.0.0.1:${billing.port}/stub/last-auth`);
const lastAuthBody = (await lastAuth.json()) as { lastBalanceAuth?: { mode?: string; account?: string } | null };
if (lastAuthBody.lastBalanceAuth?.mode !== "trusted" || lastAuthBody.lastBalanceAuth.account !== "will") {
	await fail(`the signed-in balance read did not bill as the user: ${JSON.stringify(lastAuthBody)}.`);
}

const charge = await fetch(`http://127.0.0.1:${billing.port}/stub/charge`, { method: "POST" });
if (charge.status !== 200) await fail("the stub charge control failed.");
const usage = await fetch(`${WORKER_ORIGIN}/api/billing/usage?run=e2e-run-2`, { headers: { cookie } });
const usageBody = (await usage.json()) as { totalUsd?: string; charges?: Array<unknown> };
if (usage.status !== 200 || usageBody.totalUsd !== "0.05375" || usageBody.charges?.length !== 1) {
	await fail(`the per-run usage did not read in dollars: ${JSON.stringify(usageBody)}.`);
}

const drain = await fetch(`http://127.0.0.1:${billing.port}/stub/drain`, { method: "POST" });
if (drain.status !== 200) await fail("the stub drain control failed.");
const balance2 = await fetch(`${WORKER_ORIGIN}/api/billing/balance`, { headers: { cookie } });
const balance2Body = (await balance2.json()) as { state?: string; allowedToStartWork?: boolean };
if (balance2.status !== 200 || balance2Body.state !== "empty" || balance2Body.allowedToStartWork !== false) {
	await fail(`the drained balance did not read empty/paused: ${JSON.stringify(balance2Body)}.`);
}
console.log(
	"ok: balance reads in dollars and drains to $0 with allowedToStartWork:false — the signed-in read billed AS THE USER through the trusted-caller path (stub billing, which — like the real worker — answers only an allowed origin carrying the service token + validated login, or the Cloud user bearer fallback).",
);

// The approval round trip: approve → echo, deny → echo, forced failure → honest 500.
const decide = async (approved: boolean): Promise<Response> =>
	fetch(`${WORKER_ORIGIN}/api/approvals/decision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			runId: "run_01",
			nodeId: "approve",
			iteration: 0,
			decision: { approved },
		}),
	});

const approve = await decide(true);
const approveEcho = (await approve.json()) as { approved?: boolean; runId?: string; nodeId?: string };
if (approve.status !== 200 || approveEcho.approved !== true || approveEcho.runId !== "run_01") {
	await fail(`the approve round trip did not echo: HTTP ${approve.status} ${JSON.stringify(approveEcho)}.`);
}
const forwarded = await fetch(`http://127.0.0.1:${gateway.port}/stub/last-approval`);
const forwardedBody = (await forwarded.json()) as {
	headers?: { "x-user-id"?: string };
	body?: { runId?: string; decision?: { approved?: boolean } };
};
if (forwardedBody.headers?.["x-user-id"] !== "will" || forwardedBody.body?.decision?.approved !== true) {
	await fail(`the Worker did not forward the decision with injected identity: ${JSON.stringify(forwardedBody)}.`);
}

const deny = await decide(false);
const denyEcho = (await deny.json()) as { approved?: boolean };
if (deny.status !== 200 || denyEcho.approved !== false) {
	await fail(`the deny round trip did not echo approved:false: HTTP ${deny.status}.`);
}

const forceFail = await fetch(`http://127.0.0.1:${gateway.port}/stub/fail-approval`, { method: "POST" });
if (forceFail.status !== 200) await fail("the stub fail-approval control failed.");
const failedDecision = await decide(true);
if (failedDecision.status !== 500) {
	await fail(`a gateway failure did not pass through honestly (HTTP ${failedDecision.status}).`);
}
console.log(
	"ok: approval round trip through the gateway double — approve echo, deny echo, injected identity, honest failure.",
);

/* ------------- Wave 3b/10: recommendations in the product ------------- */

// Wave 10: with no selection recorded, first-run answers needsSelection with
// the candidates inline — never an all-repos digest.
const firstRun = await fetch(`${WORKER_ORIGIN}/api/reco/first-run`, { headers: { cookie } });
if (firstRun.status !== 200) await fail(`/api/reco/first-run answered HTTP ${firstRun.status}.`);
const firstRunBody = (await firstRun.json()) as {
	needsSelection?: boolean;
	candidates?: Array<{ fullName?: string; openIssues?: number }>;
	digest?: unknown;
};
if (
	firstRunBody.needsSelection !== true ||
	!Array.isArray(firstRunBody.candidates) ||
	firstRunBody.candidates.length !== 3 ||
	firstRunBody.digest !== undefined
) {
	await fail(`the first-run answer was not the one-round-trip needsSelection: ${JSON.stringify(firstRunBody)}.`);
}
// GET watched states the never-chosen null; the candidates route lists the repos.
const watchedGet = await fetch(`${WORKER_ORIGIN}/api/reco/watched`, { headers: { cookie } });
const watchedGetBody = (await watchedGet.json()) as { selected?: unknown };
if (watchedGet.status !== 200 || watchedGetBody.selected !== null) {
	await fail(`GET /api/reco/watched did not state the null selection: ${JSON.stringify(watchedGetBody)}.`);
}
const reposList = await fetch(`${WORKER_ORIGIN}/api/reco/repos`, { headers: { cookie } });
const reposListBody = (await reposList.json()) as { candidates?: Array<{ fullName?: string }> };
if (reposList.status !== 200 || reposListBody.candidates?.[0]?.fullName !== "will/flows") {
	await fail(`GET /api/reco/repos did not list the candidates: ${JSON.stringify(reposListBody)}.`);
}

// The full onboarding journey, driven by the REAL client against the running
// Worker: loadSession chains the first-run read, the chooser card opens, the
// user toggles and confirms, the PUT lands with via:"onboarding", and the
// scoped digest arrives — plus a non-admin's /reset is an unknown command.
const pristineFetchForOnboarding = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
	if (new URL(base.url).origin !== WORKER_ORIGIN || base.headers.has("cookie")) return pristineFetchForOnboarding(base);
	const headers = new Headers(base.headers);
	headers.set("cookie", cookie);
	return pristineFetchForOnboarding(new Request(base, { headers }));
}) as typeof fetch;
try {
	const onboardingStore = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
	const onboardingController = createAppController(
		onboardingStore,
		noNativeRepos,
		createWebAgent({ baseUrl: WORKER_ORIGIN }),
		{ baseUrl: WORKER_ORIGIN },
	);
	await onboardingController.loadSession();
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (onboardingStore.collections.cards.get("repo-chooser") !== undefined) break;
		await wait(100);
	}
	const chooser = onboardingStore.collections.cards.get("repo-chooser");
	if (chooser?.kind !== "repo-chooser") await fail("the onboarding chooser card did not open on first run.");
	if (chooser.kind === "repo-chooser" && chooser.payload.candidates.length !== 3) {
		await fail("the chooser did not carry the inline candidates.");
	}
	// The non-admin refresh absence (§2): /reset resolves exactly like a typo.
	if (onboardingController.runCommand("reset")) await fail("reset was registered for a non-admin session.");
	if ((await onboardingController.commands.run("reset")).status !== "unknown-command") {
		await fail("/reset for a non-admin did not resolve as an unknown command.");
	}
	// Toggle two repos and confirm through the card's own commands.
	await onboardingController.commands.run("repos.watch.toggle", "will/flows");
	await onboardingController.commands.run("repos.watch.toggle", "will/mvp");
	await onboardingController.commands.run("repos.watch.confirm");
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (onboardingStore.collections.watchedRepos.get("watched") !== undefined) break;
		await wait(100);
	}
	const watchedRow = onboardingStore.collections.watchedRepos.get("watched");
	if (watchedRow?.via !== "onboarding" || watchedRow.selected.join(",") !== "will/flows,will/mvp") {
		await fail(`the selection did not land locally: ${JSON.stringify(watchedRow)}.`);
	}
	const stubWatched = await fetch(`http://127.0.0.1:${reco.port}/stub/watched`);
	const stubWatchedBody = (await stubWatched.json()) as {
		watched?: { selected?: Array<string>; via?: string } | null;
	};
	if (stubWatchedBody.watched?.via !== "onboarding" || stubWatchedBody.watched.selected?.length !== 2) {
		await fail(`the stub did not record the onboarding selection: ${JSON.stringify(stubWatchedBody)}.`);
	}
	const confirmLine = [...onboardingStore.collections.messages.values()].find((message) =>
		message.text.includes("change this anytime — just ask"),
	);
	if (confirmLine === undefined || !confirmLine.text.includes("Watching 2 repositories")) {
		await fail("the confirm line did not name the watched set and the just-ask path.");
	}
	if (onboardingStore.collections.cards.get("repo-chooser") !== undefined) {
		await fail("the chooser card was still open after the confirm.");
	}
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const digest = onboardingStore.collections.messages.get("message-reco-digest");
		if (digest !== undefined && digest.text.includes("2 repo")) break;
		await wait(100);
	}
	const digestMessage = onboardingStore.collections.messages.get("message-reco-digest");
	if (digestMessage === undefined || !digestMessage.text.includes("2 repo")) {
		await fail("the scoped digest did not arrive after the selection.");
	}
	// The one recommendation pill binds the reco command (§2a) — derived.
	if (!onboardingController.commands.state().hasRecommendation) {
		// The stub's scoped digest carries one recommendation; the state must see it.
		await fail("the scoped recommendation was not reflected in the command state.");
	}
} finally {
	globalThis.fetch = pristineFetchForOnboarding;
}
console.log(
	"ok: wave 10 onboarding — needsSelection one round trip, the real client opens the chooser, confirm PUTs via onboarding, the scoped digest arrives, and /reset is an unknown command for a non-admin.",
);

// The day-one logging law: accept and dismiss both post feedback.
const scopedRun = await fetch(`${WORKER_ORIGIN}/api/reco/first-run`, { headers: { cookie } });
const scopedRunBody = (await scopedRun.json()) as {
	degraded?: boolean;
	watched?: Array<string>;
	digest?: { sentence?: string; reposConsidered?: number };
	recommendation?: { id?: string; evidenceKey?: string } | null;
};
if (
	scopedRunBody.degraded !== false ||
	scopedRunBody.recommendation?.id !== "review-pr:will/flows#12" ||
	scopedRunBody.digest?.reposConsidered !== 2 ||
	scopedRunBody.watched?.length !== 2
) {
	await fail(`the scoped first-run answer did not survive the proxy: ${JSON.stringify(scopedRunBody)}.`);
}
for (const action of ["accept", "dismiss"] as const) {
	const feedback = await fetch(`${WORKER_ORIGIN}/api/reco/feedback`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({
			recommendationId: "review-pr:will/flows#12",
			action,
			evidenceKey: scopedRunBody.recommendation?.evidenceKey,
		}),
	});
	if (feedback.status !== 201) await fail(`reco feedback (${action}) answered HTTP ${feedback.status}.`);
}
// A signed-in NON-admin probe is just as undetectable as a signed-out one.
const memberUnknown = await fetch(`${WORKER_ORIGIN}/api/nope`, { headers: { cookie } });
const memberProbe = await fetch(`${WORKER_ORIGIN}/api/admin/requests`, { headers: { cookie } });
if (memberProbe.status !== 404 || (await memberProbe.text()) !== (await memberUnknown.text())) {
	await fail("the admin surface was enumerable to a signed-in non-admin.");
}
console.log(
	"ok: reco first-run scoped to the watched set + feedback round-trip through the seam; a signed-in non-admin probe is byte-identical to an unknown route.",
);

/* ------------------- Wave 3b: the admin journey ------------------- */

const makeAdmin = await fetch(`http://127.0.0.1:${identity.port}/stub/make-admin`, { method: "POST" });
if (makeAdmin.status !== 200) await fail("the stub make-admin control failed.");

// Allowlist add, attributed.
const adminAdd = await fetch(`${WORKER_ORIGIN}/api/admin/allowlist`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify({ login: "octocat", action: "add" }),
});
if (adminAdd.status !== 201) await fail(`admin allowlist add answered HTTP ${adminAdd.status}.`);
const writes = await fetch(`http://127.0.0.1:${identity.port}/stub/allowlist-writes`);
const writesBody = (await writes.json()) as {
	writes?: Array<{ login: string; requester: string; requestedAt: string }>;
};
const write = writesBody.writes?.find((entry) => entry.login === "octocat");
if (write?.requester !== "will" || !Number.isFinite(Date.parse(write.requestedAt))) {
	await fail(`the allowlist write was not attributed to the admin with a fresh timestamp: ${JSON.stringify(write)}.`);
}

// Grant, attributed, with a fresh admin: grant id.
const adminGrant = await fetch(`${WORKER_ORIGIN}/api/admin/grant`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify({ login: "octocat", amountUsd: 25 }),
});
if (adminGrant.status !== 201) await fail(`admin grant answered HTTP ${adminGrant.status}.`);
const grants = await fetch(`http://127.0.0.1:${billing.port}/stub/grants`);
const grantsBody = (await grants.json()) as {
	grants?: Array<{ userId: string; grantId: string; requester: string; amountUsd: number }>;
};
const grant = grantsBody.grants?.find((entry) => entry.userId === "octocat");
if (grant?.requester !== "will" || grant.amountUsd !== 25 || !grant.grantId.startsWith("admin:")) {
	await fail(`the grant did not reach billing with attribution: ${JSON.stringify(grant)}.`);
}

// The request queue read (will's request-access from the journey above is in it).
const queue = await fetch(`${WORKER_ORIGIN}/api/admin/requests`, { headers: { cookie } });
const queueBody = (await queue.json()) as { requests?: Array<{ login: string }> };
if (queue.status !== 200 || !queueBody.requests?.some((entry) => entry.login === "will")) {
	await fail(`the admin queue read did not list the pending request: ${JSON.stringify(queueBody)}.`);
}

// The reco feedback log read shows the day-one events.
const feedbackLog = await fetch(`${WORKER_ORIGIN}/api/admin/feedback`, { headers: { cookie } });
const feedbackLogBody = (await feedbackLog.json()) as {
	all?: Array<{ login: string; entries: Array<{ action: string }> }>;
};
const logged = feedbackLogBody.all?.find((section) => section.login === "will")?.entries ?? [];
if (feedbackLog.status !== 200 || logged.length !== 2) {
	await fail(`the admin feedback log did not show the two posted events: ${JSON.stringify(feedbackLogBody)}.`);
}

// "What failed overnight?" — real reads, honest lines.
const health = await fetch(`${WORKER_ORIGIN}/api/admin/health`, { headers: { cookie } });
const healthBody = (await health.json()) as {
	services?: Array<{ name: string; status: string }>;
	queueDepth?: number | null;
	charges?: { chargeCount: number } | null;
};
if (health.status !== 200) await fail(`admin health answered HTTP ${health.status}.`);
const healthMap = Object.fromEntries((healthBody.services ?? []).map((s) => [s.name, s.status]));
if (healthMap.billing !== "ok" || healthMap.identity !== "ok" || healthMap.reco !== "ok") {
	await fail(`admin health did not read all three services: ${JSON.stringify(healthBody)}.`);
}
if (healthBody.queueDepth !== 1 || healthBody.charges?.chargeCount !== 1) {
	await fail(`admin health missed the queue depth or charge totals: ${JSON.stringify(healthBody)}.`);
}
console.log(
	"ok: the admin journey — allowlist add with attribution, grant with attribution + fresh id, queue read, reco feedback log, health card facts.",
);

// The degraded reco answer stays honest through the seam.
const degrade = await fetch(`http://127.0.0.1:${reco.port}/stub/degrade`, { method: "POST" });
if (degrade.status !== 200) await fail("the stub degrade control failed.");
const degradedRun = await fetch(`${WORKER_ORIGIN}/api/reco/first-run`, { headers: { cookie } });
const degradedBody = (await degradedRun.json()) as { degraded?: boolean; honestMessage?: string };
if (degradedBody.degraded !== true || typeof degradedBody.honestMessage !== "string") {
	await fail(`the degraded first-run answer did not pass through honestly: ${JSON.stringify(degradedBody)}.`);
}
console.log("ok: degraded reco answers render the honestMessage, never a fake digest.");

/* ---- Wave 6c (B-3): the kill surfaces in the real client store ---- */

// Drive the REAL client (store + controller + WebAgent) against the running
// Worker: start a slow turn, capture its runId off the wire, kill it through
// the cancel route mid-flight, and assert the UI store records the turn as
// interrupted with the honest line — never silently complete or failed.
const armSlow2 = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-slow`, { method: "POST" });
if (armSlow2.status !== 200) await fail("the stub arm-slow control failed (phase B).");
const memoryStorageForKill = (): import("@tanstack/db").StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};
/*
 * The browser attaches the session cookie to every SAME-ORIGIN request; the raw
 * fetch the client-driven sections below drive must do the same, or the wave-7
 * turn gate (rightly) refuses the anonymous turn. Same-origin is the whole
 * discipline: the doubles standing in for the sibling workers are other
 * origins, and a browser would never hand them this cookie, so neither does
 * the harness.
 */
const withSessionCookie = (request: Request): Request => {
	if (new URL(request.url).origin !== WORKER_ORIGIN) return request;
	if (request.headers.has("cookie")) return request;
	const headers = new Headers(request.headers);
	headers.set("cookie", cookie);
	return new Request(request, { headers });
};

let killedRunId: string | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
	if (new URL(base.url).pathname === "/api/agent/turn") {
		const body = (await base.clone().json().catch(() => undefined)) as { runId?: string } | undefined;
		if (typeof body?.runId === "string") killedRunId = body.runId;
	}
	return originalFetch(withSessionCookie(base));
}) as typeof fetch;
// Patched before createWebAgent: the agent binds fetch at construction.
const killStore = await createAppStore({ kind: "localStorage", storage: memoryStorageForKill() });
const killController = createAppController(
	killStore,
	{
		available: false,
		pickLocalRepository: async () => ({
			status: "error" as const,
			code: "native-required",
			message: "no native bridge in the e2e",
		}),
	},
	createWebAgent({ baseUrl: WORKER_ORIGIN }),
	{ baseUrl: WORKER_ORIGIN },
);
try {
	killController.send("a slow turn to kill");
	for (let attempt = 0; attempt < 100 && killedRunId === undefined; attempt += 1) await wait(100);
	if (killedRunId === undefined) await fail("never observed the client's turn runId on the wire.");
	const clientKill = await fetch(`${WORKER_ORIGIN}/api/agent/turn/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ runId: killedRunId }),
	});
	const clientKillBody = (await clientKill.json()) as { status?: string };
	if (clientKill.status !== 200 || clientKillBody.status !== "cancelled") {
		await fail(`the client-turn kill did not answer cancelled: HTTP ${clientKill.status} ${JSON.stringify(clientKillBody)}.`);
	}
	let recorded = false;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const killedMessage = [...killStore.collections.messages.values()].find(
			(message) => message.id === `message-${killedRunId}-smithers` && message.status === "interrupted",
		);
		if (
			killedMessage !== undefined &&
			killedMessage.statusDetail === "That turn was stopped by the server." &&
			killStore.session().phase === "idle"
		) {
			recorded = true;
			break;
		}
		await wait(100);
	}
	if (!recorded) {
		const messages = [...killStore.collections.messages.values()].map((m) => `${m.id}:${m.status}`);
		await fail(`the killed turn was not recorded interrupted in the UI store (${messages.join(", ")}).`);
	}
} finally {
	globalThis.fetch = originalFetch;
}
const armDefault2 = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-default`, { method: "POST" });
if (armDefault2.status !== 200) await fail("the stub arm-default control failed (phase B).");
console.log(
	"ok: the kill surfaces in the real client — the store records the turn interrupted with the honest line and the session returns to idle.",
);

/* ------------- Wave 3b: the agent tool loop, end to end ------------- */

// Arm the stub model's tool-call script, then drive the REAL client (store +
// controller + WebAgent) against the running Worker: the model asks for
// /world.new-note, the registry executes it, the continuation goes back, and
// the final text acknowledges it.
const arm = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-tool-loop`, { method: "POST" });
if (arm.status !== 200) await fail("the stub arm-tool-loop control failed.");

const memoryStorage = (): import("@tanstack/db").StorageApi => {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
};
// Same browser-cookie discipline as the kill section above: the client's turn
// POSTs carry the journey's session cookie, or the wave-7 turn gate 401s them.
// Restores the pristine fetch (not the kill section's patch) when the section ends.
const originalFetchForTools = originalFetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
	return originalFetchForTools(withSessionCookie(base));
}) as typeof fetch;
const e2eStore = await createAppStore({ kind: "localStorage", storage: memoryStorage() });
const e2eController = createAppController(
	e2eStore,
	{
		available: false,
		pickLocalRepository: async () => ({
			status: "error" as const,
			code: "native-required",
			message: "no native bridge in the e2e",
		}),
	},
	createWebAgent({ baseUrl: WORKER_ORIGIN }),
	{ baseUrl: WORKER_ORIGIN },
);
e2eController.send("make me a note");
let ack = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
	const documents = [...e2eStore.collections.worldDocuments.values()];
	const noteCreated = documents.some((document) => document.path.startsWith("Untitled"));
	const finalMessage = [...e2eStore.collections.messages.values()].find(
		(message) => message.text.includes("the note exists now") && message.status === "complete",
	);
	if (noteCreated && finalMessage !== undefined && e2eStore.session().phase === "idle") {
		ack = true;
		break;
	}
	await wait(100);
}
if (!ack) {
	await fail("the tool loop did not complete: note, acknowledging final text, and idle phase were not all observed.");
}
const actLines = [...e2eStore.collections.messages.values()].filter((message) => message.act !== undefined);
if (actLines.length !== 1 || actLines[0]?.text !== "Smithers ran /world.new-note") {
	await fail(`the tool act was not visible in the transcript: ${JSON.stringify(actLines.map((m) => m.text))}.`);
}
console.log(
	"ok: tool loop end to end — the stub model called /world.new-note, the registry created the note, the final text acknowledged it, and the act line rendered.",
);
globalThis.fetch = originalFetchForTools;

/* ---- Wave 10: the agent-tool selection change ("just ask Smithers") ---- */

// The model calls /repos.watch with a repo argument through the tool loop;
// the chooser card opens EMBEDDED (the surface never changes), pre-selected,
// and the user's confirm PUTs with via:"agent".
const armRepos = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-tool-loop-repos`, {
	method: "POST",
});
if (armRepos.status !== 200) await fail("the stub arm-tool-loop-repos control failed.");
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
	return originalFetchForTools(withSessionCookie(base));
}) as typeof fetch;
try {
	const agentStore = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
	const agentController = createAppController(
		agentStore,
		noNativeRepos,
		createWebAgent({ baseUrl: WORKER_ORIGIN }),
		{ baseUrl: WORKER_ORIGIN },
	);
	agentController.send("watch my smithers repo too");
	let opened = false;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const card = agentStore.collections.cards.get("repo-chooser");
		const finalMessage = [...agentStore.collections.messages.values()].find(
			(message) => message.text.includes("the chooser is open") && message.status === "complete",
		);
		if (card !== undefined && finalMessage !== undefined && agentStore.session().phase === "idle") {
			opened = true;
			break;
		}
		await wait(100);
	}
	if (!opened) await fail("the agent's repos.watch invocation did not open the chooser card in the transcript.");
	// THE EMBED LAW: the agent's invocation never moved the surface.
	if (agentStore.session().surface !== "chat") {
		await fail("the agent's repos.watch invocation opened a takeover instead of the embedded card.");
	}
	const agentChooser = agentStore.collections.cards.get("repo-chooser");
	if (agentChooser?.kind !== "repo-chooser") await fail("the agent chooser card was not a repo-chooser.");
	if (agentChooser.kind === "repo-chooser") {
		if (agentChooser.payload.via !== "agent") await fail("the agent-opened chooser did not record via:agent.");
		// Pre-selected on top of the current set (will/flows, will/mvp from onboarding).
		if (!agentChooser.payload.selected.includes("will/smithers")) {
			await fail(`the agent's repo argument did not pre-select: ${JSON.stringify(agentChooser.payload.selected)}.`);
		}
	}
	const agentActs = [...agentStore.collections.messages.values()].filter((message) => message.act !== undefined);
	if (agentActs.length !== 1 || agentActs[0]?.text !== "Smithers ran /repos.watch") {
		await fail(`the agent act line was not the compact one-liner: ${JSON.stringify(agentActs.map((m) => m.text))}.`);
	}
	// The user's confirm is the act that is genuinely theirs.
	await agentController.commands.run("repos.watch.confirm");
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (agentStore.collections.cards.get("repo-chooser") === undefined) break;
		await wait(100);
	}
	const stubWatchedAfter = await fetch(`http://127.0.0.1:${reco.port}/stub/watched`);
	const stubWatchedAfterBody = (await stubWatchedAfter.json()) as {
		watched?: { selected?: Array<string>; via?: string } | null;
	};
	if (stubWatchedAfterBody.watched?.via !== "agent" || !stubWatchedAfterBody.watched.selected?.includes("will/smithers")) {
		await fail(`the agent-path selection did not land via:agent: ${JSON.stringify(stubWatchedAfterBody)}.`);
	}
} finally {
	globalThis.fetch = originalFetchForTools;
}
const armDefault3 = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-default`, { method: "POST" });
if (armDefault3.status !== 200) await fail("the stub arm-default control failed (agent repos section).");
console.log(
	"ok: agent-tool selection change — the tool-loop double invoked /repos.watch, the embedded chooser opened pre-selected (via:agent), the surface never changed, and the confirm landed the new set.",
);

/* ---------------- Wave 11: workflows in the conversation ---------------- */

/*
 * The whole bar, driven by the REAL client against the REAL Worker with the
 * relay double behind it: "make me a workflow that summarizes my open issues"
 * → provision-or-resume → launch create-workflow → an embedded run card that
 * tracks the run live → the approval only the human decides → auto-resume →
 * the completed card leading with the result in words.
 */
// The degraded-reco section above left the seam degraded; a scoped digest is
// what mirrors the watched set into the client, so restore the healthy answer.
const undegrade = await fetch(`http://127.0.0.1:${reco.port}/stub/undegrade`, { method: "POST" });
if (undegrade.status !== 200) await fail("the stub undegrade control failed.");
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	const base = typeof input === "string" || input instanceof URL ? new Request(input, init) : (input as Request);
	return originalFetchForTools(withSessionCookie(base));
}) as typeof fetch;
try {
	const wfStore = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
	const wfController = createAppController(wfStore, noNativeRepos, createWebAgent({ baseUrl: WORKER_ORIGIN }), {
		baseUrl: WORKER_ORIGIN,
		workflowPollMs: 150,
	});
	// The signed-in, allowlisted session and the watched set are both live at
	// the doubles by now (will/flows, will/mvp, will/smithers) — the watched
	// set is the universe this seam runs in.
	await wfController.loadSession();
	await wfController.loadFirstRunReco();

	/*
	 * Wave 12 §2: three repos are watched here, so WHICH one is a genuine user
	 * choice — the chooser-among-watched renders embedded and nothing is
	 * provisioned on a guess. One act answers it and the create resumes.
	 */
	const asked = await wfController.commands.run("workflow.create", "a workflow that summarizes my open issues");
	// A question is an honest answer, not a launch: the command says what it
	// needs (the wave-10 chooser convention) and the card carries the choice.
	const askedLine = asked.status === "failed" ? asked.error : (asked.value ?? "");
	if (!askedLine.includes("choose the one this workflow belongs to")) {
		await fail(`workflow.create did not ask which watched repo: ${JSON.stringify(asked)}.`);
	}
	const askCard = wfStore.collections.cards.get("workflow-repo");
	if (askCard?.kind !== "workflow-repo" || askCard.payload.repos.length < 2) {
		await fail(`the which-repo question did not render as an embedded card: ${JSON.stringify(askCard)}.`);
	}
	if (wfStore.session().surface !== "chat") await fail("the which-repo question moved the surface.");
	const beforeAsk = ((await (await fetch(`http://127.0.0.1:${gateway.port}/stub/relay-state`)).json()) as {
		runs: Array<unknown>;
	}).runs.length;
	if (beforeAsk !== 0) await fail("the which-repo question launched something on a guess.");
	const chosenRepo = askCard.kind === "workflow-repo" ? (askCard.payload.repos[0] ?? "") : "";

	const created = await wfController.commands.run("workflow.repo.choose", chosenRepo);
	if (created.status !== "executed") {
		await fail(`workflow.repo.choose did not execute: ${JSON.stringify(created)}.`);
	}
	// §1: the tool result is a MINIMAL machine acknowledgment, not a paragraph
	// of warnings the model can round up from.
	const createdValue = created.status === "executed" ? (created.value ?? "") : "";
	if (!/^run-started workflow=create-workflow run=\S+ repo=\S+$/.test(createdValue)) {
		await fail(`the launch did not answer a minimal machine acknowledgment: ${JSON.stringify(createdValue)}.`);
	}

	// The relay saw a provision and exactly one launch, with the user's words
	// as the stock create-workflow's input.
	const relayState = await fetch(`http://127.0.0.1:${gateway.port}/stub/relay-state`);
	const relayBody = (await relayState.json()) as {
		provisions: number;
		runs: Array<{ runId: string; workflow: string; input: unknown; status: string }>;
	};
	if (relayBody.provisions < 1) await fail("the workflow seam never provisioned a gateway.");
	if (relayBody.runs.length !== 1 || relayBody.runs[0]?.workflow !== "create-workflow") {
		await fail(`the relay did not see one create-workflow launch: ${JSON.stringify(relayBody.runs)}.`);
	}
	if (JSON.stringify(relayBody.runs[0]?.input) !== JSON.stringify({ prompt: "a workflow that summarizes my open issues" })) {
		await fail(`create-workflow's input was not the user's description: ${JSON.stringify(relayBody.runs[0]?.input)}.`);
	}
	const runId = relayBody.runs[0]?.runId ?? "";
	const runCardId = `workflow-run-${runId}`;

	// THE EMBED LAW: a card in the transcript, and the surface never moved.
	const launched = wfStore.collections.cards.get(runCardId);
	if (launched?.kind !== "workflow-run") await fail("the launch did not render an embedded run card.");
	if (wfStore.session().surface !== "chat") await fail("the run card opened a takeover instead of embedding.");

	// The run goes live and parks on its approval gate.
	let parked: string | undefined;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const card = wfStore.collections.cards.get(runCardId);
		if (card?.kind === "workflow-run" && card.payload.phase === "waiting-approval") {
			parked = [...wfStore.collections.cards.values()].find(
				(entry) => entry.kind === "approval" && entry.id.startsWith(`approval-${runId}-`),
			)?.id;
			if (parked !== undefined) break;
		}
		await wait(100);
	}
	if (parked === undefined) await fail("the run card never reached waiting-approval with an approval card.");
	const liveCard = wfStore.collections.cards.get(runCardId);
	if (liveCard?.kind === "workflow-run") {
		// Node progress in WORDS, never a raw payload.
		const steps = liveCard.payload.steps.join(" ");
		if (!steps.includes("clarify")) await fail(`the run card did not narrate node progress: ${steps}.`);
		if (steps.includes("{")) await fail(`the run card leaked a raw payload: ${steps}.`);
		if (liveCard.payload.lastSeq < 1) await fail("the run card's event cursor never advanced.");
	}

	// The outbound act waits for the human's explicit yes.
	await wfController.commands.run("approval.approve", parked);
	let completed = false;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const card = wfStore.collections.cards.get(runCardId);
		if (card?.kind === "workflow-run" && card.payload.phase === "completed") {
			completed = true;
			break;
		}
		await wait(100);
	}
	if (!completed) await fail("the approved run never completed on the run card.");
	const done = wfStore.collections.cards.get(runCardId);
	if (done?.kind === "workflow-run") {
		if (done.payload.result === null || !done.payload.result.includes("summarize-open-issues")) {
			await fail(`the completed card did not lead with the result: ${JSON.stringify(done.payload.result)}.`);
		}
	}
	const resultLine = [...wfStore.collections.messages.values()].find((message) =>
		message.text.includes("summarize-open-issues"),
	);
	if (resultLine === undefined) await fail("the completed run never stated its result in the chat.");

	// The decision round-tripped through the per-user gateway (the relay path),
	// not the static upstream: the stub recorded it via /v1/rpc/submitApproval
	// behind /api/gateways/{id}.
	const lastApproval = await fetch(`http://127.0.0.1:${gateway.port}/stub/last-approval`);
	const lastApprovalBody = (await lastApproval.json()) as { body?: { runId?: string; decision?: unknown } } | null;
	if (lastApprovalBody?.body?.runId !== runId) {
		await fail(`the approval did not reach the gateway for this run: ${JSON.stringify(lastApprovalBody)}.`);
	}

	// workflow.list presents the workspace's workflows as an embedded card.
	const listed = await wfController.commands.run("workflow.list");
	if (listed.status !== "executed") await fail(`workflow.list did not execute: ${JSON.stringify(listed)}.`);
	const listCard = [...wfStore.collections.cards.values()].find((card) => card.kind === "workflow-list");
	if (listCard?.kind !== "workflow-list" || !listCard.payload.workflows.some((entry) => entry.key === "create-workflow")) {
		await fail("workflow.list did not render the workspace's workflows as an embedded card.");
	}
	if (wfStore.session().surface !== "chat") await fail("workflow.list moved the surface.");

	// A gateway token must never have reached this browser client. The client
	// only ever talks to /api/workflow/*; the Worker holds the credential.
	const provisionProbe = await fetch(`${WORKER_ORIGIN}/api/workflow/provision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ repo: "will/flows" }),
	});
	const provisionText = await provisionProbe.text();
	if (provisionText.includes("smithers_gateway") || provisionText.includes("smithers_pat")) {
		await fail("the provision answer leaked a credential to the browser.");
	}
	// And provision-or-resume is idempotent — that probe resumed, it did not
	// mint a second gateway for the repo.
	const afterProbe = await fetch(`http://127.0.0.1:${gateway.port}/stub/relay-state`);
	const afterProbeBody = (await afterProbe.json()) as { gateways: Array<string> };
	if (afterProbeBody.gateways.length !== 1) {
		await fail(`provision-or-resume was not idempotent: ${JSON.stringify(afterProbeBody.gateways)}.`);
	}

	// The §5 taxonomy, end to end: no_capacity is an honest state, not a retry
	// loop and not a 500 in the browser's face.
	const armNoCapacity = await fetch(`http://127.0.0.1:${gateway.port}/stub/no-capacity`, { method: "POST" });
	if (armNoCapacity.status !== 200) await fail("the stub no-capacity control failed.");
	const beforeNoCapacity = ((await (await fetch(`http://127.0.0.1:${gateway.port}/stub/relay-state`)).json()) as {
		provisions: number;
	}).provisions;
	const noCapacity = await fetch(`${WORKER_ORIGIN}/api/workflow/provision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ repo: "will/smithers" }),
	});
	const noCapacityBody = (await noCapacity.json()) as { status?: string; message?: string };
	if (noCapacity.status !== 200 || noCapacityBody.status !== "no-capacity") {
		await fail(`no_capacity did not surface as an honest state: HTTP ${noCapacity.status} ${JSON.stringify(noCapacityBody)}.`);
	}
	const afterNoCapacity = ((await (await fetch(`http://127.0.0.1:${gateway.port}/stub/relay-state`)).json()) as {
		provisions: number;
	}).provisions;
	if (afterNoCapacity - beforeNoCapacity !== 1) {
		await fail(`no_capacity was retry-looped (${afterNoCapacity - beforeNoCapacity} provision attempts).`);
	}
	await fetch(`http://127.0.0.1:${gateway.port}/stub/capacity`, { method: "POST" });

	/*
	 * Wave 12 §4: a watched repo with no Smithers Cloud counterpart gets its
	 * own honest line, through the real Worker and out to the real client —
	 * never the provision seam's raw HTTP failure.
	 */
	await fetch(`http://127.0.0.1:${gateway.port}/stub/no-cloud-repo`, { method: "POST" });
	const noCloudRepo = await fetch(`${WORKER_ORIGIN}/api/workflow/provision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ repo: "will/smithers" }),
	});
	const noCloudRepoBody = (await noCloudRepo.json()) as { status?: string; message?: string };
	if (noCloudRepo.status !== 200 || noCloudRepoBody.status !== "no-cloud-repo") {
		await fail(`a repo with no Cloud counterpart was not its own state: ${JSON.stringify(noCloudRepoBody)}.`);
	}
	const noCloudSaid = await wfController.commands.run("workflow.create", "summarize my issues will/smithers");
	const noCloudLine = noCloudSaid.status === "failed" ? noCloudSaid.error : (noCloudSaid.value ?? "");
	if (!noCloudLine.includes("isn't on Smithers Cloud yet")) {
		await fail(`the client did not state the no-Cloud-repo case honestly: ${JSON.stringify(noCloudLine)}.`);
	}
	await fetch(`http://127.0.0.1:${gateway.port}/stub/cloud-repo`, { method: "POST" });

	/*
	 * Wave 12 §3: a run the workspace never finishes. The stub launches a run
	 * that starts and is never heard from again while getRun keeps answering
	 * "running" — exactly the live wave-11 shape. The card must say so, the
	 * pump must stop, and the two acts must be there.
	 */
	await fetch(`http://127.0.0.1:${gateway.port}/stub/stalled-runs`, { method: "POST" });
	const quietStore = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
	const quietController = createAppController(quietStore, noNativeRepos, createWebAgent({ baseUrl: WORKER_ORIGIN }), {
		baseUrl: WORKER_ORIGIN,
		workflowPollMs: 150,
		// The production bound is 10 minutes; the e2e proves the mechanism.
		workflowQuietMs: 900,
	});
	await quietController.loadSession();
	await quietController.loadFirstRunReco();
	const stalledLaunch = await quietController.commands.run("workflow.run", `wave4-relay-proof ${chosenRepo}`);
	if (stalledLaunch.status !== "executed") {
		await fail(`the stalled run did not launch: ${JSON.stringify(stalledLaunch)}.`);
	}
	const stalledRunId = /run=(\S+)/.exec(stalledLaunch.status === "executed" ? (stalledLaunch.value ?? "") : "")?.[1] ?? "";
	const quietCardId = `workflow-run-${stalledRunId}`;
	let wentQuiet = false;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const card = quietStore.collections.cards.get(quietCardId);
		if (card?.kind === "workflow-run" && card.payload.phase === "quiet") {
			wentQuiet = true;
			break;
		}
		await wait(100);
	}
	if (!wentQuiet) await fail("a run that never progressed never reached the honest quiet state.");
	/*
	 * The pump STOPPED hammering the workspace — read off the relay's own count
	 * of event reads, not off the card. (The first cut of this check compared a
	 * run COUNT against nothing and could not have failed; a bar that cannot
	 * fail is not a bar.)
	 */
	const relayReads = async (): Promise<number> =>
		((await (await fetch(`http://127.0.0.1:${gateway.port}/stub/relay-state`)).json()) as { eventReads: number })
			.eventReads;
	const readsAtQuiet = await relayReads();
	if (readsAtQuiet < 1) await fail("the stalled run never reached the relay.");
	await wait(600);
	const stillQuiet = quietStore.collections.cards.get(quietCardId);
	if (stillQuiet?.kind !== "workflow-run" || stillQuiet.payload.phase !== "quiet") {
		await fail("the quiet card did not hold its stance.");
	}
	const readsAfterQuiet = await relayReads();
	if (readsAfterQuiet !== readsAtQuiet) {
		await fail(
			`the quiet card kept polling the workspace: ${readsAtQuiet} → ${readsAfterQuiet} event reads after it went quiet.`,
		);
	}
	// The two acts are registered commands: check again, or stop watching.
	const retried = await quietController.commands.run("workflow.run.retry", quietCardId);
	if (retried.status !== "executed") await fail(`workflow.run.retry did not execute: ${JSON.stringify(retried)}.`);
	// "Check again" really re-reads the workspace — otherwise it is a label.
	await wait(500);
	if ((await relayReads()) <= readsAfterQuiet) {
		await fail("workflow.run.retry did not actually check the run again.");
	}
	const stopped = await quietController.commands.run("workflow.run.stop", quietCardId);
	if (stopped.status !== "executed") await fail(`workflow.run.stop did not execute: ${JSON.stringify(stopped)}.`);
	await wait(300);
	const stoppedCard = quietStore.collections.cards.get(quietCardId);
	if (stoppedCard?.kind !== "workflow-run" || stoppedCard.payload.phase !== "stopped") {
		await fail(`stop watching did not settle the card honestly: ${JSON.stringify(stoppedCard)}.`);
	}
	// Stop is stop: no further reads reach the relay for this run.
	const readsAtStop = await relayReads();
	await wait(600);
	if ((await relayReads()) !== readsAtStop) {
		await fail("stop watching did not stop the pump — the relay was still being polled.");
	}
	await fetch(`http://127.0.0.1:${gateway.port}/stub/lively-runs`, { method: "POST" });

	// No Cloud identity is stated as itself, and nothing is provisioned.
	await fetch(`http://127.0.0.1:${identity.port}/stub/no-cloud-identity`, { method: "POST" });
	const noIdentity = await fetch(`${WORKER_ORIGIN}/api/workflow/provision`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ repo: "will/smithers" }),
	});
	const noIdentityBody = (await noIdentity.json()) as { status?: string };
	if (noIdentityBody.status !== "no-cloud-identity") {
		await fail(`a missing Cloud identity was not stated honestly: ${JSON.stringify(noIdentityBody)}.`);
	}
	await fetch(`http://127.0.0.1:${identity.port}/stub/cloud-identity`, { method: "POST" });
	/*
	 * Wave 12 §1, the truth test: the EXACT wave-11 canary turn replayed
	 * through the real client against the real Worker. The model calls
	 * workflow.create and then claims the workflow "has been created and is now
	 * running". The RENDERED turn must not carry that, whatever the model said.
	 */
	const armLie = await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-tool-loop-workflow-lie`, {
		method: "POST",
	});
	if (armLie.status !== 200) await fail("the stub arm-tool-loop-workflow-lie control failed.");
	const truthStore = await createAppStore({ kind: "localStorage", storage: e2eMemoryStorage() });
	const truthController = createAppController(truthStore, noNativeRepos, createWebAgent({ baseUrl: WORKER_ORIGIN }), {
		baseUrl: WORKER_ORIGIN,
		workflowPollMs: 150,
	});
	await truthController.loadSession();
	await truthController.loadFirstRunReco();
	truthController.send("can you make me a smithers workflow that summarizes my open issues?");
	let settledTurn = false;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (
			truthStore.session().phase === "idle" &&
			[...truthStore.collections.cards.values()].some((card) => card.kind === "workflow-run")
		) {
			settledTurn = true;
			break;
		}
		await wait(100);
	}
	if (!settledTurn) await fail("the replayed wave-11 turn never settled with a run card.");
	const renderedTurn = [...truthStore.collections.messages.values()]
		.sort((left, right) => left.ordinal - right.ordinal)
		.map((message) => message.text)
		.join("\n");
	if (renderedTurn.includes("has been created")) {
		await fail(`the rendered turn shipped the wave-11 claim: ${JSON.stringify(renderedTurn)}.`);
	}
	if (renderedTurn.includes("summarize-open-issues")) {
		await fail(`the rendered turn shipped the invented workflow name: ${JSON.stringify(renderedTurn)}.`);
	}
	if (!renderedTurn.includes("I started a create-workflow run — the run card shows its real progress.")) {
		await fail(`the deterministic line was not rendered in its place: ${JSON.stringify(renderedTurn)}.`);
	}
	if (!renderedTurn.includes("Smithers started a create-workflow run on will/flows")) {
		await fail(`the deterministic act line did not name the run the client started: ${JSON.stringify(renderedTurn)}.`);
	}
	await fetch(`http://127.0.0.1:${chatUpstream.port}/stub/arm-default`, { method: "POST" });
} finally {
	globalThis.fetch = originalFetchForTools;
}
console.log(
	"ok: wave-12 truth — the replayed wave-11 canary turn renders the deterministic line, never 'has been created'; the which-repo question is asked among watched repos and answered in one act; a run the workspace never finishes goes honestly quiet with stop/retry; and a watched repo with no Cloud counterpart states that in its own words.",
);
console.log(
	"ok: wave-11 workflows in the conversation — provision-or-resume (idempotent, token server-side only), create-workflow launched with the user's words, the EMBEDDED run card tracked the run live in words, the approval round-tripped through the per-user gateway, auto-resume completed it and the card led with the result, workflow.list embedded, and the no_capacity / no-cloud-identity taxonomy surfaced honestly without a retry loop.",
);

await stopWorker();
cleanup();
console.log(
	"PASS: worker e2e — build, wrangler dev, streamed turn, server-side kill (mid-stream cancelled frame + client-store interrupted + late-kill not-found), seam discipline, auth journey, one-page auth conversation states (signed-out send, request-access via chat, failed-OAuth message), $0 drain, approval round trip, wave-10 onboarding (needsSelection, chooser, via-onboarding PUT, scoped digest, non-admin reset absence), agent-tool selection change (via:agent, embedded card), admin journey, non-admin undetectability, agent tool loop, wave-11 workflows in the conversation (per-user gateway provision-or-resume, create-workflow from the user's words, the embedded run card live, the approval round trip through the relay, auto-resume to a result stated in words, and the honest no_capacity / no-cloud-identity taxonomy), and wave-12 truth (the replayed canary turn rendering the deterministic line instead of 'has been created', the which-watched-repo question answered in one act, a never-finishing run going honestly quiet with stop/retry, and the no-Cloud-repo state in its own words).",
);
process.exit(0);
