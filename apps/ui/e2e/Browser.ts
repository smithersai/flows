/*
 * The hermetic e2e harness — the browser half.
 *
 * One system Chrome over the DevTools protocol, the same way the launch
 * checklist's scripts/headless-page.ts and scripts/web-chat-e2e.ts already
 * drive the app. No Playwright and no download, so a CI runner needs nothing
 * beyond the Chrome its image already ships.
 *
 * Discovery, argv and the target URL come from src/launch-checklist/
 * BrowserLaunch.ts, which is unit-tested; only the socket glue lives here.
 *
 * Two rules this file exists to enforce:
 *
 *  - Every wait is bounded. A page that stops answering the DevTools protocol
 *    must fail its suite with the method and target named, never park the run.
 *    A CI job that hangs burns its whole timeout and reports nothing.
 *  - Only a machine with NO browser is a skip. A machine that has Chrome and
 *    cannot drive it throws BrowserLaunchError, which is a failure. Degrading
 *    a crashed browser to a skip deletes the coverage it was meant to prove.
 */
import { existsSync, rmSync } from "node:fs";
import {
	NO_BROWSER_REASON,
	browserArgv,
	findBrowser,
	newTargetUrl,
} from "../src/launch-checklist/BrowserLaunch.ts";
import { BrowserUnavailableError, type ProbePage } from "../src/launch-checklist/Types.ts";

/**
 * How long one DevTools call may wait for its answer.
 *
 * Two minutes, not thirty seconds: a11y-resilience walks every computed style
 * in the dark tree, and on a loaded machine that one Runtime.evaluate crossed
 * 30s and turned a passing row red. A stuck call still fails inside the
 * runner's per-suite deadline, which is the real backstop.
 */
const CDP_TIMEOUT_MS = Number(process.env.FLOWS_E2E_CDP_TIMEOUT_MS ?? 120_000);

/** How long the DevTools websocket may take to open before the launch is called dead. */
const SOCKET_OPEN_TIMEOUT_MS = 15_000;

/** How long one /json/new probe may hang before the next attempt. */
const TARGET_PROBE_TIMEOUT_MS = 5_000;

/*
 * How long one navigation waits, and how many navigations a mount gets. See
 * `navigate`: a page that lands mid-`wrangler dev` reload never mounts however
 * long it is given, so the budget stays modest and the retry does the work.
 */
const DOCUMENT_BUDGET_MS = 20_000;
const MOUNT_BUDGET_MS = 20_000;
const NAVIGATE_ATTEMPTS = 3;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A DevTools call that never answered. Thrown, not returned, and never a skip:
 * the browser existed and stopped talking, which is a failure of the thing
 * under test or of the browser driving it.
 */
export class CdpTimeoutError extends Error {
	readonly method: string;
	readonly target: string;
	constructor(method: string, target: string, timeoutMs: number) {
		super(`CDP ${method} on ${target} did not answer within ${timeoutMs}ms`);
		this.name = "CdpTimeoutError";
		this.method = method;
		this.target = target;
	}
}

/**
 * A browser binary exists but could not be driven — it never bound its
 * debugging port, never opened a target, or died mid-session.
 *
 * Deliberately NOT a BrowserUnavailableError: only "this machine has no
 * browser at all" may downgrade a row to a skip. Everything else is red.
 */
export class BrowserLaunchError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "BrowserLaunchError";
	}
}

/** True only for the one condition a suite may answer with a `skip:` line. */
export const isBrowserUnavailable = (error: unknown): error is BrowserUnavailableError =>
	error instanceof BrowserUnavailableError;

export interface CdpSession {
	/** Raw DevTools protocol call. Rejects on a protocol error, or with CdpTimeoutError. */
	readonly send: (method: string, params?: Record<string, unknown>) => Promise<any>;
	/** The ProbePage view of this session: text/evaluate/type/press/reload. */
	readonly page: ProbePage;
	/** Console errors captured since the page opened. */
	readonly consoleErrors: () => ReadonlyArray<string>;
	/** Emulation.setDeviceMetricsOverride shorthand. */
	readonly viewport: (width: number, height: number) => Promise<void>;
	/** Emulation.setEmulatedMedia shorthand, e.g. ("prefers-reduced-motion", "reduce"). */
	readonly media: (feature: string, value: string) => Promise<void>;
	readonly close: () => void;
}

export interface E2eBrowser {
	/** True when a system Chrome/Chromium was found. */
	readonly available: boolean;
	/** Why not, when `available` is false. */
	readonly reason: string | undefined;
	/**
	 * A fresh session on `origin` carrying `cookie`. Rejects with
	 * BrowserUnavailableError when the machine has no browser, and with
	 * BrowserLaunchError or CdpTimeoutError when it has one that will not drive.
	 */
	readonly open: (cookie?: string) => Promise<CdpSession>;
	/**
	 * `open`, except the one skippable condition comes back as undefined instead
	 * of a throw. Use this wherever a suite wants to skip a browser-only section
	 * on a machine with no Chrome:
	 *
	 *     const session = await browser.openIfAvailable(cookie);
	 *     if (session === undefined) { console.log(`skip: E3.9 — ${browser.reason}`); return; }
	 *
	 * A crashed or unreachable browser still throws, so it cannot silently
	 * delete the rows the section was written to prove.
	 */
	readonly openIfAvailable: (cookie?: string) => Promise<CdpSession | undefined>;
	/**
	 * Close every page this browser still has open, without stopping the
	 * browser itself. Closing a session's DEBUGGER socket leaves its TAB
	 * running, and a tab that launched a workflow keeps polling the shared
	 * stack every poll interval for the rest of the run — so the suites after
	 * it wait behind a queue of abandoned pumps. The runner calls this between
	 * suites.
	 */
	readonly closeSessions: () => Promise<void>;
	readonly close: () => Promise<void>;
}

interface Connection {
	send(method: string, params?: Record<string, unknown>): Promise<any>;
	on(event: string, listener: (params: any) => void): void;
	close(): void;
}

/**
 * The DevTools debugging port and profile directory, derived per run.
 *
 * A fixed port and a fixed profile made two concurrent runners fight over both
 * and inherit each other's failures. Stack.ts already derives its wrangler
 * persist directory per run; this follows that precedent, keyed on the port the
 * stack is serving (which is FLOWS_E2E_PORT, or --port) plus the pid.
 */
export const debugPortFor = (origin: string, env: Readonly<Record<string, string | undefined>> = process.env): number => {
	const fromOrigin = Number(URL.parse(origin)?.port ?? Number.NaN);
	const base = Number.isFinite(fromOrigin) && fromOrigin > 0 ? fromOrigin : Number(env.FLOWS_E2E_PORT ?? 8791);
	// The stack serves the 8xxx band, so +1000 keeps the pair adjacent and
	// readable in `lsof`. 9444 belongs to the launch checklist and 9333 to
	// web-chat-e2e; step past either rather than fight it for the port.
	const derived = base + 1000;
	return derived === 9444 || derived === 9333 ? derived + 1 : derived;
};

const connect = async (socketUrl: string, target: string): Promise<Connection> => {
	const socket = new WebSocket(socketUrl);
	await new Promise<void>((resolve, reject) => {
		// Chrome can accept the TCP connection and never finish the upgrade; without
		// this timer that await is the hang.
		const timer = setTimeout(() => {
			reject(new BrowserLaunchError(`the CDP socket at ${socketUrl} did not open within ${SOCKET_OPEN_TIMEOUT_MS}ms`));
		}, SOCKET_OPEN_TIMEOUT_MS);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve();
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new BrowserLaunchError(`could not open a CDP socket at ${socketUrl}`));
		});
		socket.addEventListener("close", () => {
			clearTimeout(timer);
			reject(new BrowserLaunchError(`the CDP socket at ${socketUrl} closed before it opened`));
		});
	});
	let nextId = 0;
	const pending = new Map<
		number,
		{ method: string; settle: () => void; resolve: (result: any) => void; reject: (error: Error) => void }
	>();
	const listeners = new Map<string, Array<(params: any) => void>>();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { message: string };
		};
		if (message.id === undefined) {
			if (message.method !== undefined) {
				for (const listener of listeners.get(message.method) ?? []) listener(message.params);
			}
			return;
		}
		const waiter = pending.get(message.id);
		pending.delete(message.id);
		if (waiter === undefined) return;
		waiter.settle();
		if (message.error !== undefined) waiter.reject(new Error(`CDP ${message.error.message}`));
		else waiter.resolve(message.result);
	});
	// A crashed tab drops the socket. Fail the calls it will never answer now,
	// rather than making every one of them serve its full timeout first.
	socket.addEventListener("close", () => {
		for (const [id, waiter] of pending) {
			pending.delete(id);
			waiter.settle();
			waiter.reject(new BrowserLaunchError(`the CDP socket to ${target} closed while ${waiter.method} was in flight`));
		}
	});
	return {
		send: (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = (nextId += 1);
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new CdpTimeoutError(method, target, CDP_TIMEOUT_MS));
				}, CDP_TIMEOUT_MS);
				pending.set(id, { method, settle: () => clearTimeout(timer), resolve, reject });
				try {
					socket.send(JSON.stringify({ id, method, params }));
				} catch (error) {
					pending.delete(id);
					clearTimeout(timer);
					reject(new BrowserLaunchError(`CDP ${method} on ${target} could not be sent: ${String(error)}`));
				}
			}),
		on: (event, listener) => {
			const existing = listeners.get(event) ?? [];
			existing.push(listener);
			listeners.set(event, existing);
		},
		close: () => socket.close(),
	};
};

/** One named key press, as real key events. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	// Space activates a focused button exactly as Enter does; a suite that
	// claims keyboard access has to be able to press the other one.
	Space: { key: " ", code: "Space", keyCode: 32, text: " " },
	"/": { key: "/", code: "Slash", keyCode: 191, text: "/" },
};

export const createE2eBrowser = (origin: string): E2eBrowser => {
	const binary = findBrowser({ explicit: process.env.E2E_BROWSER, env: process.env, exists: existsSync });
	const debugPort = debugPortFor(origin);
	const profileDir = `${process.env.TMPDIR ?? "/tmp"}/flows-e2e-browser-${debugPort}-${process.pid}`;
	const connections: Array<Connection> = [];
	let browserProcess: { kill(): void } | undefined;

	const launchOnce = (): void => {
		if (browserProcess !== undefined || binary === undefined) return;
		const argv = [...browserArgv(binary, debugPort, profileDir)];
		// A containerised runner has no user namespace, so headless Chrome refuses
		// to start without these two.
		if (process.env.CI === "true") argv.splice(1, 0, "--no-sandbox", "--disable-dev-shm-usage");
		browserProcess = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	};

	const openTarget = async (): Promise<Connection> => {
		for (let attempt = 0; attempt < 80; attempt += 1) {
			try {
				const response = await fetch(newTargetUrl(debugPort, "about:blank"), {
					method: "PUT",
					signal: AbortSignal.timeout(TARGET_PROBE_TIMEOUT_MS),
				});
				const descriptor = (await response.json()) as { id?: string; webSocketDebuggerUrl?: string };
				if (descriptor.webSocketDebuggerUrl !== undefined) {
					const target = `${origin} target ${descriptor.id ?? "?"} on port ${debugPort}`;
					return await connect(descriptor.webSocketDebuggerUrl, target);
				}
			} catch (error) {
				// Chrome is still starting up — unless the socket itself is the problem,
				// which is a launch failure and must not be retried into a timeout.
				if (error instanceof BrowserLaunchError) throw error;
			}
			await wait(250);
		}
		throw new BrowserLaunchError(
			`the browser at ${binary} never exposed a DevTools endpoint on port ${debugPort} (profile ${profileDir})`,
		);
	};

	const open = async (cookie?: string): Promise<CdpSession> => {
		if (binary === undefined) throw new BrowserUnavailableError(NO_BROWSER_REASON);
		launchOnce();
		const cdp = await openTarget();
		connections.push(cdp);
		const consoleErrors: Array<string> = [];
		cdp.on("Runtime.consoleAPICalled", (params: { type?: string; args?: ReadonlyArray<{ value?: unknown }> }) => {
			if (params.type !== "error") return;
			consoleErrors.push((params.args ?? []).map((arg) => String(arg.value ?? "")).join(" "));
		});
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");
		await cdp.send("Network.enable");
		await cdp.send("Log.enable");
		if (cookie !== undefined) await cdp.send("Network.setExtraHTTPHeaders", { headers: { cookie } });
		// A fresh slate: a previous suite's persisted transcript must never read as this one's.
		await cdp.send("Storage.clearDataForOrigin", {
			origin,
			storageTypes: "file_systems,local_storage,indexeddb,cache_storage,websql,service_workers",
		});

		const evaluate = async <T>(expression: string): Promise<T> => {
			const answer = await cdp.send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
			});
			if (answer?.exceptionDetails !== undefined) {
				throw new Error(`page evaluation failed: ${JSON.stringify(answer.exceptionDetails).slice(0, 300)}`);
			}
			return answer?.result?.value as T;
		};
		/*
		 * `readyState === "complete"` means the document loaded, not that the app
		 * rendered. React mounts after it, and the gap widens on a loaded machine
		 * or across a `wrangler dev` reload — enough that a suite's own mount wait
		 * can time out against a product that is merely slow. That produced a
		 * roaming flake: whichever suite happened to run while the machine was
		 * busy failed on "the composer never mounted", in a different suite each
		 * run.
		 *
		 * Waiting for the mount here, once, fixes it for every suite. The shell's
		 * `[data-flows]` manifest is the signal: the app publishes it from the
		 * live registry, so its presence means React rendered and the registry is
		 * up, not merely that HTML arrived.
		 *
		 * A navigation that lands mid-reload never mounts at all, so the whole
		 * navigation is retried rather than waited on longer. After the last
		 * attempt this throws: an app that truly never mounts is a product
		 * failure and must not be smoothed into a silent pass.
		 */
		const settle = async (predicate: string, budgetMs: number): Promise<boolean> => {
			const deadline = Date.now() + budgetMs;
			while (Date.now() < deadline) {
				const met = await evaluate<boolean>(predicate).catch((error: unknown) => {
					// A page that stopped answering is not a page that is still loading.
					if (error instanceof CdpTimeoutError || error instanceof BrowserLaunchError) throw error;
					return false;
				});
				if (met === true) return true;
				await wait(250);
			}
			return false;
		};
		const navigate = async (): Promise<void> => {
			for (let attempt = 1; attempt <= NAVIGATE_ATTEMPTS; attempt += 1) {
				await cdp.send("Page.navigate", { url: origin });
				if (!(await settle(`document.readyState === "complete"`, DOCUMENT_BUDGET_MS))) continue;
				if (await settle(`document.querySelector("[data-flows]") !== null`, MOUNT_BUDGET_MS)) return;
			}
			throw new Error(
				`${origin} never mounted its app shell: no [data-flows] manifest after ${NAVIGATE_ATTEMPTS} navigations, ` +
					`each waiting ${DOCUMENT_BUDGET_MS}ms for the document and ${MOUNT_BUDGET_MS}ms for the mount.`,
			);
		};
		const dispatch = async (descriptor: {
			key: string;
			code: string;
			keyCode: number;
			text?: string;
		}): Promise<void> => {
			for (const type of ["keyDown", "keyUp"]) {
				await cdp.send("Input.dispatchKeyEvent", {
					type,
					key: descriptor.key,
					code: descriptor.code,
					windowsVirtualKeyCode: descriptor.keyCode,
					nativeVirtualKeyCode: descriptor.keyCode,
					...(type === "keyDown" && descriptor.text !== undefined ? { text: descriptor.text } : {}),
				});
			}
		};
		await navigate();

		const page: ProbePage = {
			text: () => evaluate<string>("document.body.innerText"),
			evaluate,
			type: async (value: string) => {
				for (const character of value) {
					await dispatch({
						key: character,
						code: `Key${character.toUpperCase()}`,
						keyCode: character.charCodeAt(0),
						text: character,
					});
				}
			},
			press: async (key: string) => {
				const descriptor = KEYS[key];
				if (descriptor === undefined) throw new Error(`no key descriptor for ${key}`);
				await dispatch(descriptor);
			},
			reload: navigate,
		};

		return {
			send: cdp.send,
			page,
			consoleErrors: () => consoleErrors,
			viewport: async (width, height) => {
				await cdp.send("Emulation.setDeviceMetricsOverride", {
					width,
					height,
					deviceScaleFactor: 1,
					mobile: width < 700,
				});
			},
			media: async (feature, value) => {
				await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: feature, value }] });
			},
			close: () => {
				// The tab goes with the socket: a page left running keeps its
				// timers, its pumps and its network alive on the shared stack.
				void cdp.send("Page.close").catch(() => undefined);
				cdp.close();
			},
		};
	};

	return {
		available: binary !== undefined,
		reason: binary === undefined ? NO_BROWSER_REASON : undefined,
		open,
		openIfAvailable: async (cookie?: string) => {
			if (binary === undefined) return undefined;
			return await open(cookie);
		},
		closeSessions: async () => {
			for (const connection of connections) {
				try {
					await connection.send("Page.close");
				} catch {
					// Already closed, or the tab is gone — either way there is
					// nothing left running on it.
				}
				connection.close();
			}
			connections.length = 0;
		},
		close: async () => {
			for (const connection of connections) connection.close();
			browserProcess?.kill();
			browserProcess = undefined;
			await wait(100);
			// The profile was this run's alone; leaving it behind litters a
			// developer's temp directory one boot at a time.
			try {
				rmSync(profileDir, { recursive: true, force: true });
			} catch {
				// Chrome may still hold a handle; a stale temp directory is not a failure.
			}
		},
	};
};
