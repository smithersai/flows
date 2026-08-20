/*
 * Shared boot for the browser e2e scripts under scripts/.
 *
 * One place owns the three things each of them needs: a built SPA served by a
 * real `wrangler dev`, a scripted chat upstream so no model credential is ever
 * spent, and a CDP target on a browser this machine actually has. Before this
 * file every script hardcoded
 * "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" and assumed a
 * dev server was already listening on localhost:5173, so all three ran on
 * exactly one machine and only when a human had started vite first.
 *
 * Nothing here reaches the network beyond the local ports it opens and the
 * `bun x wrangler` fetch. The seam wiring is the phase-B wiring worker-e2e.ts
 * uses; this is that recipe made reusable, not a second one.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	NO_BROWSER_REASON,
	browserArgv,
	findBrowser,
	newTargetUrl,
} from "../src/launch-checklist/BrowserLaunch.ts";
import {
	STUB_ADMIN_TOKEN,
	STUB_BILLING_BEARER,
	STUB_PRODUCT_TOKEN,
	createStubBilling,
	createStubGateway,
	createStubIdentity,
	createStubReco,
} from "./stub-backends";

/*
 * `bun x wrangler` resolves the newest release on every run, so a wrangler
 * release could turn any of these suites red without a commit. Pin it.
 */
export const WRANGLER_SPECIFIER = "wrangler@4.124.0";

const UI_DIR = fileURLToPath(new URL("../", import.meta.url));
const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The opening words of every scripted reply. Assert against this, never a restated literal. */
export const HERMETIC_REPLY_PREFIX = "Smithers here. The runtime context says";

export interface ScriptedTurn {
	readonly instructions: string;
	readonly messages: unknown;
}

export interface ScriptedChat {
	readonly url: string;
	/** Every turn body the double received, in order. */
	readonly turns: ReadonlyArray<ScriptedTurn>;
	readonly stop: () => void;
}

/**
 * A chat.smithers.sh double that answers one NDJSON turn per POST and spends
 * nothing. The Worker composes the hidden runtime context into a single
 * `instructions` string before forwarding (apps/server/src/index.ts, the
 * `composeAgentInstructions(body.instructions, body.context)` call), so the
 * double reads the context back off the wire and echoes it: the reply is
 * deterministic AND it proves the round trip.
 */
export const startScriptedChat = (): ScriptedChat => {
	const turns: Array<ScriptedTurn> = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (!url.pathname.endsWith("/chat")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as { instructions?: string; messages?: unknown };
			const instructions = body.instructions ?? "";
			turns.push({ instructions, messages: body.messages });
			const theme = /- Theme: (light|dark)/.exec(instructions)?.[1] ?? "unknown";
			const surface = /- Current surface: (\w+)/.exec(instructions)?.[1] ?? "unknown";
			const text = `${HERMETIC_REPLY_PREFIX} the ${surface} surface is in ${theme} mode.`;
			// The frame shape is worker-e2e.ts's: a text delta, then done.
			const frames = [
				{ type: "delta", kind: "text", text },
				{ type: "done", reason: "stop" },
			];
			return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
				status: 200,
				headers: { "content-type": "application/x-ndjson" },
			});
		},
	});
	const port = server.port;
	if (port === undefined) throw new Error("the scripted chat double bound no TCP port");
	return { url: `http://127.0.0.1:${port}/chat`, turns, stop: () => server.stop(true) };
};

export interface HermeticApp {
	/** The origin the browser should be pointed at. */
	readonly origin: string;
	/** `name=value` for a signed-in, allowlisted stub session. */
	readonly cookie: string;
	readonly chat: ScriptedChat;
	readonly stop: () => void;
}

const reachable = async (url: string): Promise<boolean> => {
	try {
		return (await fetch(url)).ok;
	} catch {
		return false;
	}
};

/**
 * Builds the SPA, boots `wrangler dev` with every seam pointed at a double,
 * and hands back a signed-in allowlisted session on an origin the browser can
 * open. Costs one vite build plus one wrangler boot, so roughly a minute.
 */
export const startHermeticApp = async (options: { readonly workerPort: number }): Promise<HermeticApp> => {
	const origin = `http://127.0.0.1:${options.workerPort}`;

	/*
	 * A wrangler left behind by an interrupted run keeps the port and answers
	 * every probe, so the boot below "succeeds" against a stack wired to doubles
	 * that are already dead. Refuse instead: the failure is then the true one.
	 */
	if (await reachable(origin)) {
		throw new Error(
			`something is already listening on ${origin}. Stop it (a previous run's \`wrangler dev\` outlives an interrupted script) and try again.`,
		);
	}

	console.error("[harness] building the SPA (vite build)...");
	const build = Bun.spawn(["bun", "run", "build"], { cwd: UI_DIR, stdout: "inherit", stderr: "inherit" });
	if ((await build.exited) !== 0) throw new Error("the SPA build failed");

	/*
	 * `wrangler dev` rewrites request URLs to the route in wrangler.jsonc, so
	 * the Worker's proxy states THAT origin to the doubles, not localhost. The
	 * doubles must allowlist it exactly like the real workers' ALLOWED_ORIGINS.
	 */
	const config = await Bun.file(new URL("../../server/wrangler.jsonc", import.meta.url)).text();
	const routeHost = /"pattern"\s*:\s*"([^"/]+)"/.exec(config)?.[1];
	const presented: ReadonlyArray<string> = routeHost === undefined ? [] : [`http://${routeHost}`];

	const identity = createStubIdentity(presented);
	const billing = createStubBilling(presented);
	const gateway = createStubGateway();
	const reco = createStubReco(presented);
	const chat = startScriptedChat();

	/*
	 * `wrangler dev` auto-loads .dev.vars, which on a developer machine points
	 * the seams at the LIVE stack. Blank every seam var first so an inherited
	 * value cannot silently repoint one of them mid-run.
	 */
	const sealed: Record<string, string> = {
		IDENTITY_UPSTREAM_URL: `http://127.0.0.1:${identity.port}`,
		IDENTITY_SERVICE_TOKEN: "stub-service-token",
		IDENTITY_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
		BILLING_UPSTREAM_URL: `http://127.0.0.1:${billing.port}`,
		BILLING_AUTH_TOKEN: STUB_BILLING_BEARER,
		BILLING_PRODUCT_SERVICE_TOKEN: STUB_PRODUCT_TOKEN,
		BILLING_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
		CHAT_PRODUCT_SERVICE_TOKEN: "",
		RECO_UPSTREAM_URL: `http://127.0.0.1:${reco.port}`,
		RECO_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
		GATEWAY_UPSTREAM_URL: `http://127.0.0.1:${gateway.port}`,
		GATEWAY_AUTH_TOKEN: "",
		GATEWAY_SESSION_USER_ID: "will",
		SMITHERS_CLOUD_API_BASE_URL: `http://127.0.0.1:${gateway.port}`,
		SMITHERS_CHAT_AUTH_TOKEN: "",
		SMITHERS_CHAT_URL: chat.url,
	};
	console.error(`[harness] booting wrangler dev on ${origin}...`);
	const wrangler = Bun.spawn(
		[
			"bun",
			"x",
			WRANGLER_SPECIFIER,
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			String(options.workerPort),
			...Object.entries(sealed).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
		],
		{ cwd: SERVER_DIR, stdout: "inherit", stderr: "inherit" },
	);

	const stop = (): void => {
		wrangler.kill();
		chat.stop();
		identity.stop();
		billing.stop();
		gateway.stop();
		reco.stop();
	};

	let up = false;
	for (let attempt = 0; attempt < 120 && !up; attempt += 1) {
		up = await reachable(origin);
		if (!up) await wait(500);
	}
	if (!up) {
		stop();
		throw new Error(`wrangler dev never came up on ${origin}`);
	}

	// Mint a session the same way worker-e2e.ts does: start → callback → cookie.
	const start = await fetch(`${origin}/api/auth/github/start`, { redirect: "manual" });
	const location = start.headers.get("location");
	if (start.status !== 302 || location === null) {
		stop();
		throw new Error(`the sign-in start did not redirect (HTTP ${start.status})`);
	}
	const callback = await fetch(`${origin}${location}`, { redirect: "manual" });
	const setCookie = callback.headers.get("set-cookie");
	if (callback.status !== 302 || setCookie === null || !setCookie.includes("stub_session=")) {
		stop();
		throw new Error("the sign-in callback did not issue a session cookie");
	}
	const cookie = setCookie.split(";")[0] ?? "";

	// The stub user starts signed-in-but-not-allowlisted, and a non-allowlisted
	// session cannot take a turn at all.
	const allowlisted = await fetch(`http://127.0.0.1:${identity.port}/stub/allowlist`, { method: "POST" });
	if (!allowlisted.ok) {
		stop();
		throw new Error(`the stub allowlist control answered HTTP ${allowlisted.status}`);
	}

	/*
	 * The reco double starts with no watched selection, which makes first run
	 * open the repo chooser instead of a plain chat. Answer it up front so the
	 * scripts assert on the conversation rather than on onboarding.
	 */
	const watched = await fetch(`${origin}/api/reco/watched`, {
		method: "PUT",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({ selected: ["will/flows"], via: "onboarding" }),
	});
	if (!watched.ok) {
		stop();
		throw new Error(`seeding the watched set answered HTTP ${watched.status}`);
	}

	return { origin, cookie, chat, stop };
};

export interface CdpTarget {
	readonly socketUrl: string;
	readonly kill: () => void;
}

/**
 * The raw CDP escape hatch, for the scripts that need Network sniffing or
 * device-metric overrides that headless-page.ts's ProbePage does not expose.
 * `extraArgs` is spliced in front of the trailing `about:blank` because
 * browserArgv builds a complete argv and does not take extra flags.
 */
export const openCdpTarget = async (options: {
	readonly port: number;
	readonly userDataDir: string;
	readonly url: string;
	readonly extraArgs?: ReadonlyArray<string>;
}): Promise<CdpTarget> => {
	const binary = findBrowser({ explicit: process.env.CHECKLIST_BROWSER, env: process.env, exists: existsSync });
	if (binary === undefined) throw new Error(NO_BROWSER_REASON);
	const argv = [...browserArgv(binary, options.port, options.userDataDir)];
	argv.splice(argv.length - 1, 0, ...(options.extraArgs ?? []));
	const chrome = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(newTargetUrl(options.port, options.url), { method: "PUT" });
			const target = (await response.json()) as { webSocketDebuggerUrl?: string };
			if (target.webSocketDebuggerUrl !== undefined) {
				return { socketUrl: target.webSocketDebuggerUrl, kill: () => chrome.kill() };
			}
		} catch {
			// Chrome is still starting up.
		}
		await wait(250);
	}
	chrome.kill();
	throw new Error("Chrome DevTools endpoint never became available.");
};

export interface CdpSession {
	readonly send: (method: string, params?: Record<string, unknown>) => Promise<any>;
	readonly evaluate: (expression: string) => Promise<any>;
	readonly typeKey: (key: string, code: string, keyCode: number, text?: string) => Promise<void>;
	readonly typeText: (text: string) => Promise<void>;
	readonly close: () => void;
	/** Raw CDP events, for scripts that sniff the wire. */
	readonly onEvent: (listener: (message: CdpEvent) => void) => void;
}

export interface CdpEvent {
	readonly method?: string;
	readonly params?: { request?: { url?: string; method?: string; postData?: string } };
}

/** Opens a websocket to `socketUrl` and wraps the request/response bookkeeping. */
export const connectCdp = async (socketUrl: string): Promise<CdpSession> => {
	const socket = new WebSocket(socketUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("Could not open a CDP socket.")));
	});

	let nextId = 0;
	const pending = new Map<number, (result: unknown) => void>();
	const listeners: Array<(message: CdpEvent) => void> = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			method?: string;
			params?: { request?: { url?: string; method?: string; postData?: string } };
			result?: unknown;
			error?: { message: string };
		};
		if (message.id === undefined) {
			for (const listener of listeners) listener(message);
			return;
		}
		pending.get(message.id)?.(message.error ? { cdpError: message.error.message } : message.result);
		pending.delete(message.id);
	});

	const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
		const id = (nextId += 1);
		return new Promise((resolve) => {
			pending.set(id, resolve);
			socket.send(JSON.stringify({ id, method, params }));
		});
	};

	const evaluate = async (expression: string): Promise<any> => {
		const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result?.exceptionDetails !== undefined) {
			throw new Error(`Page evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
		}
		return result?.result?.value;
	};

	const typeKey = async (key: string, code: string, keyCode: number, text?: string): Promise<void> => {
		for (const type of ["keyDown", "keyUp"]) {
			await send("Input.dispatchKeyEvent", {
				type,
				key,
				code,
				windowsVirtualKeyCode: keyCode,
				nativeVirtualKeyCode: keyCode,
				// `text` on keyDown is what actually inserts the character.
				...(type === "keyDown" && text !== undefined ? { text } : {}),
			});
		}
	};

	const typeText = async (text: string): Promise<void> => {
		for (const character of text) {
			await typeKey(character, `Key${character.toUpperCase()}`, character.toUpperCase().charCodeAt(0), character);
			await wait(6);
		}
	};

	return {
		send,
		evaluate,
		typeKey,
		typeText,
		close: () => socket.close(),
		onEvent: (listener) => void listeners.push(listener),
	};
};

/**
 * Everything except cookies. `storageTypes: "all"` drops the session cookie
 * the harness just minted, which silently signs the page out.
 */
export const CLEARABLE_STORAGE = "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers";
