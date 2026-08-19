/*
 * The hermetic e2e harness — the stack.
 *
 * One `wrangler dev` per phase, in front of four test doubles, each behind a
 * programmable front. The boot recipe is the one scripts/worker-e2e.ts proved,
 * with two changes: the environment seal covers all 19 seam vars (worker-e2e
 * seals 14, so a phase-A workflow call there can still reach the real
 * api.jjhub.tech), and Durable Object state is persisted to a per-run temp
 * directory so a concurrent worker-e2e.ts run cannot share it.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createStubBilling,
	createStubGateway,
	createStubIdentity,
	createStubReco,
	STUB_ADMIN_TOKEN,
	STUB_BILLING_BEARER,
	STUB_PRODUCT_TOKEN,
	type StubHandle,
} from "../scripts/stub-backends.ts";
import { createChatUpstream, type ChatUpstream } from "./ChatUpstream.ts";
import { createFront, type Front } from "./Front.ts";
import type { Phase } from "./Suite.ts";

/** wrangler.jsonc's `main` and `assets.directory` are relative to apps/server. */
const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));
const UI_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The version apps/server/scripts/deploy.ts pins, so CI fetches one known wrangler. */
const WRANGLER = "wrangler@4.123.0";

export type StubName = "identity" | "billing" | "gateway" | "reco";

export interface StackOptions {
	readonly phase: Phase;
	/** Default 8791, or $FLOWS_E2E_PORT. Deliberately not 8790 — worker-e2e owns that. */
	readonly port?: number;
	/** Skip `bun run build` (the runner builds once for the whole run). Default false. */
	readonly skipBuild?: boolean;
	/** Extra --var entries, merged last. */
	readonly extraVars?: Readonly<Record<string, string>>;
}

export interface Stack {
	readonly origin: string;
	readonly phase: Phase;
	/** The Origin the Worker's proxy presents to the doubles, e.g. ["http://canary.smithers.sh"]. */
	readonly presentedOrigins: ReadonlyArray<string>;
	readonly fronts: {
		readonly identity: Front;
		readonly billing: Front;
		readonly gateway: Front;
		readonly reco: Front;
	};
	readonly stubs: {
		readonly identity: StubHandle;
		readonly billing: StubHandle;
		readonly gateway: StubHandle;
		readonly reco: StubHandle;
	};
	readonly chat: ChatUpstream;
	/** POST/GET a /stub/* control on a double, THROUGH the front. Throws on a non-2xx. */
	readonly control: (target: StubName, path: string, init?: RequestInit) => Promise<Response>;
	/** Mint a fresh session cookie ("stub_session=<uuid>"). Not allowlisted yet. */
	readonly signIn: () => Promise<string>;
	/** Flip the identity double's global allowlist flag. */
	readonly allowlist: () => Promise<void>;
	/** Flip the identity double's global admin flag. */
	readonly makeAdmin: () => Promise<void>;
	/** Memoized signIn() + allowlist(). Cleared by reset(). The cookie most suites want. */
	readonly signedInCookie: () => Promise<string>;
	/**
	 * Per-suite isolation. Recreates the identity, billing and reco doubles and
	 * repoints their fronts; clears every front override; resets the chat
	 * double; puts the gateway back to capacity/lively/cloud-repo; forgets the
	 * memoized cookie.
	 *
	 * The gateway double is NOT recreated: the Worker's GATEWAY_SESSIONS Durable
	 * Object caches each provisioned gateway's base_url per (login, repo), so a
	 * recreated gateway would be resumed on a dead port. Gateway counters
	 * therefore accumulate within a phase — assert deltas, and provision under a
	 * suite-unique repo name.
	 */
	readonly reset: () => Promise<void>;
	readonly stop: () => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `bun run build` in apps/ui with an explicit cwd. Throws on a non-zero exit. */
export const buildSpa = async (): Promise<void> => {
	const build = Bun.spawn(["bun", "run", "build"], { cwd: UI_DIR, stdout: "inherit", stderr: "inherit" });
	if ((await build.exited) !== 0) throw new Error("the SPA build (vite build) failed.");
};

/**
 * `wrangler dev` rewrites request URLs to the route in wrangler.jsonc, so the
 * Worker's proxy states THAT origin to the doubles, not localhost. Derived from
 * the config so a route change cannot silently rebreak the doubles' origin gate.
 */
export const devPresentedOrigins = async (): Promise<ReadonlyArray<string>> => {
	const config = await Bun.file(new URL("../../server/wrangler.jsonc", import.meta.url)).text();
	const host = /"pattern"\s*:\s*"([^"/]+)"/.exec(config)?.[1];
	return host === undefined ? [] : [`http://${host}`];
};

/**
 * Every seam var the Worker declares, forced to "" (an empty value reads as
 * unset). `wrangler dev` auto-loads apps/server/.dev.vars and wrangler.jsonc
 * sets four upstreams to production hosts, so this seal is what makes a run
 * hermetic. `--var` wins over both.
 */
const SEALED_VARS: ReadonlyArray<string> = [
	"IDENTITY_UPSTREAM_URL",
	"IDENTITY_SERVICE_TOKEN",
	"IDENTITY_ADMIN_TOKEN",
	"BILLING_UPSTREAM_URL",
	"BILLING_AUTH_TOKEN",
	"BILLING_PRODUCT_SERVICE_TOKEN",
	"BILLING_ADMIN_TOKEN",
	"CHAT_PRODUCT_SERVICE_TOKEN",
	"RECO_UPSTREAM_URL",
	"RECO_ADMIN_TOKEN",
	"GATEWAY_UPSTREAM_URL",
	"GATEWAY_AUTH_TOKEN",
	"GATEWAY_SESSION_USER_ID",
	"GATEWAY_SESSION_USER_ROLE",
	"GATEWAY_SESSION_USER_SCOPES",
	"SMITHERS_CHAT_AUTH_TOKEN",
	"SMITHERS_CLOUD_API_BASE_URL",
];

export const startStack = async (options: StackOptions): Promise<Stack> => {
	const { phase } = options;
	const port = options.port ?? Number(process.env.FLOWS_E2E_PORT ?? 8791);
	const origin = `http://127.0.0.1:${port}`;
	const presentedOrigins = await devPresentedOrigins();

	if (options.skipBuild !== true) await buildSpa();

	const stubs: Record<StubName, StubHandle> = {
		identity: createStubIdentity(presentedOrigins),
		billing: createStubBilling(presentedOrigins),
		gateway: createStubGateway(),
		reco: createStubReco(presentedOrigins),
	};
	const fronts = {
		identity: createFront("identity", stubs.identity.port),
		billing: createFront("billing", stubs.billing.port),
		gateway: createFront("gateway", stubs.gateway.port),
		reco: createFront("reco", stubs.reco.port),
	};
	const chat = createChatUpstream();

	const vars: Record<string, string> = {};
	for (const name of SEALED_VARS) vars[name] = "";
	Object.assign(
		vars,
		phase === "A"
			? { SMITHERS_CHAT_URL: chat.url }
			: {
					SMITHERS_CHAT_URL: chat.url,
					IDENTITY_UPSTREAM_URL: fronts.identity.url,
					IDENTITY_SERVICE_TOKEN: "stub-service-token",
					BILLING_UPSTREAM_URL: fronts.billing.url,
					BILLING_AUTH_TOKEN: STUB_BILLING_BEARER,
					BILLING_PRODUCT_SERVICE_TOKEN: STUB_PRODUCT_TOKEN,
					CHAT_PRODUCT_SERVICE_TOKEN: STUB_PRODUCT_TOKEN,
					GATEWAY_UPSTREAM_URL: fronts.gateway.url,
					GATEWAY_SESSION_USER_ID: "will",
					// Wave 11: the same double serves the Cloud provision route and the
					// per-gateway surface it hands back.
					SMITHERS_CLOUD_API_BASE_URL: fronts.gateway.url,
					RECO_UPSTREAM_URL: fronts.reco.url,
					IDENTITY_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
					BILLING_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
					RECO_ADMIN_TOKEN: STUB_ADMIN_TOKEN,
				},
		options.extraVars ?? {},
	);

	const persistDir = `${process.env.TMPDIR ?? "/tmp"}/flows-e2e-wrangler-${process.pid}-${phase}`;
	let wrangler: ReturnType<typeof Bun.spawn> | undefined = Bun.spawn(
		[
			"bun",
			"x",
			WRANGLER,
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			String(port),
			"--persist-to",
			persistDir,
			...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
		],
		{ cwd: SERVER_DIR, stdout: "inherit", stderr: "inherit" },
	);

	const stopEverything = async (): Promise<void> => {
		wrangler?.kill();
		wrangler = undefined;
		await wait(750);
		for (const front of Object.values(fronts)) front.stop();
		for (const stub of Object.values(stubs)) stub.stop();
		chat.stop();
		// The Durable Object state was this run's alone; leaving it behind litters
		// a developer's temp directory one boot at a time.
		try {
			rmSync(persistDir, { recursive: true, force: true });
		} catch {
			// wrangler may still hold a handle; a stale temp directory is not a failure.
		}
	};

	let up = false;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(origin);
			if (response.ok) {
				up = true;
				break;
			}
		} catch {
			// wrangler is still starting.
		}
		await wait(500);
	}
	if (!up) {
		await stopEverything();
		throw new Error(`wrangler dev never came up on ${origin}.`);
	}

	const control = async (target: StubName, path: string, init: RequestInit = {}): Promise<Response> => {
		const response = await fetch(`${fronts[target].url}${path}`, init);
		if (!response.ok) {
			throw new Error(`the ${target} control ${path} answered HTTP ${response.status}.`);
		}
		return response;
	};

	const signIn = async (): Promise<string> => {
		const start = await fetch(`${origin}/api/auth/github/start`, { redirect: "manual" });
		const location = start.headers.get("location");
		if (start.status !== 302 || location === null) {
			throw new Error(`the sign-in start did not redirect (HTTP ${start.status}).`);
		}
		const callback = await fetch(`${origin}${location}`, { redirect: "manual" });
		const setCookie = callback.headers.get("set-cookie");
		if (callback.status !== 302 || setCookie === null || !setCookie.includes("stub_session=")) {
			throw new Error("the sign-in callback did not issue a session cookie.");
		}
		return setCookie.split(";")[0] ?? "";
	};

	let memoizedCookie: Promise<string> | undefined;

	return {
		origin,
		phase,
		presentedOrigins,
		fronts,
		stubs: {
			get identity() {
				return stubs.identity;
			},
			get billing() {
				return stubs.billing;
			},
			get gateway() {
				return stubs.gateway;
			},
			get reco() {
				return stubs.reco;
			},
		},
		chat,
		control,
		signIn,
		allowlist: async () => void (await control("identity", "/stub/allowlist", { method: "POST" })),
		makeAdmin: async () => void (await control("identity", "/stub/make-admin", { method: "POST" })),
		signedInCookie: () => {
			if (memoizedCookie === undefined) {
				memoizedCookie = (async () => {
					const cookie = await signIn();
					await control("identity", "/stub/allowlist", { method: "POST" });
					return cookie;
				})();
			}
			return memoizedCookie;
		},
		/*
		 * Every double answers POST /stub/reset by returning to its boot state.
		 * Reset through that one control rather than by re-creating the servers:
		 * a re-created double listens on a new port and forces
		 * `front.setUpstream`, and the gateway cannot be re-created at all
		 * because GATEWAY_SESSIONS caches each provisioned gateway's base_url
		 * per (login, repo) and would resume a dead port.
		 *
		 * The gateway previously reset through /stub/capacity, /stub/lively-runs
		 * and /stub/cloud-repo, which is partial: it left the previous suite's
		 * runs, gateways, RPC and cursor ledgers, notification and BYOK stores,
		 * import jobs, issues and environments in place. A suite reading
		 * /stub/relay-state or /stub/platform-calls then saw another suite's
		 * traffic and could pass or fail for the wrong reason.
		 */
		reset: async () => {
			for (const front of Object.values(fronts)) front.clear();
			for (const name of ["identity", "billing", "gateway", "reco"] as const) {
				await control(name, "/stub/reset", { method: "POST" });
			}
			chat.reset();
			memoizedCookie = undefined;
		},
		stop: stopEverything,
	};
};
