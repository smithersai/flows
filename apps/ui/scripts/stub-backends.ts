/**
 * TEST DOUBLES for local development and the worker e2e — never deployed.
 *
 * These stubs honor the real backend contracts so the product Worker's seams
 * can be exercised without GitHub, the identity worker, the billing worker, or
 * the engine gateway:
 *
 *   - identity: the wave2 identity-allowlist contract (/api/auth/*, /api/identity/*)
 *   - billing:  workers/billing's real response shapes (dollars, allowedToStartWork)
 *   - gateway:  the engine gateway's submitApproval RPC echo
 *
 * Every `/stub/*` route is a test control (drive state directly); control
 * routes live ONLY on the stub origin — the product Worker never proxies them.
 *
 * Run standalone for `wrangler dev`: bun scripts/stub-backends.ts
 * (prints the IDENTITY_UPSTREAM_URL / BILLING_UPSTREAM_URL / GATEWAY_UPSTREAM_URL
 * values to pass as --var).
 */

import type { Server } from "bun";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

/**
 * Bun types a served port as optional because a unix-socket server has none.
 * These stubs all bind TCP on port 0, so the assigned port is always there —
 * and a stub that somehow did not bind must fail loudly, not report port 0.
 */
const listeningPort = (server: Server<undefined>): number => {
	if (server.port === undefined) throw new Error("stub server bound no TCP port");
	return server.port;
};

export interface StubHandle {
	readonly port: number;
	readonly stop: () => void;
}

/** Both sibling workers allow any localhost origin outright; everything else must be configured. */
const LOCAL_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

/**
 * The doubles' origin gate, modeling the real siblings' ALLOWED_ORIGINS.
 * `wrangler dev` rewrites request URLs to the route in wrangler.jsonc, so the
 * product Worker's proxy states THAT origin (http://canary.smithers.sh in
 * dev), not localhost — the harness passes it here exactly like the real
 * workers list the product Worker's origin in ALLOWED_ORIGINS.
 */
const originAllowed = (origin: string, extraAllowedOrigins: ReadonlyArray<string>): boolean =>
	LOCAL_ORIGIN.test(origin) || extraAllowedOrigins.includes(origin);

/**
 * The Smithers Cloud user bearer the billing double accepts. The real billing
 * worker authenticates the account with this credential and nothing else, so
 * the double refuses anything without it.
 */
export const STUB_BILLING_BEARER = "stub-cloud-bearer";

/**
 * The product service token the billing double accepts on the wave-5
 * trusted-caller path (`x-smithers-service-token` + `x-user-login`), exactly
 * like the real worker's PRODUCT_SERVICE_TOKEN. A wrong token opens nothing.
 */
export const STUB_PRODUCT_TOKEN = "stub-product-service-token";

/**
 * The one admin token every stub's admin surface accepts. The real siblings
 * each hold their own ADMIN_SERVICE_TOKEN; the double shares one for local
 * convenience, and each stub's admin routes 404/401 without it exactly like
 * the landed contracts.
 */
export const STUB_ADMIN_TOKEN = "stub-admin-token";

/* ------------------------------------------------------------------ */
/* Identity stub — contract: wave2-identity-allowlist-worker.md        */
/* ------------------------------------------------------------------ */

/** The real shape of GET /api/auth/scopes: whole-sentence `plain` per scope. */
const IDENTITY_SCOPES = {
	provider: "github",
	requestedScopes: ["read:user", "repo"],
	scopes: [
		{
			scope: "read:user",
			plain: "See your GitHub profile — your username, name, and avatar.",
			why: "Sign-in needs to know who you are.",
		},
		{
			scope: "repo",
			plain: "Read access to your repositories, including private ones.",
			why: "The repository connector reads the repositories you choose to work on.",
		},
	],
};

export const createStubIdentity = (extraAllowedOrigins: ReadonlyArray<string> = []): StubHandle => {
	// Stub state: the signed-in user is always "will" (a placeholder handle,
	// never a real account). allowlisted flips via the /stub/allowlist control,
	// admin via /stub/make-admin (as the real worker's ADMIN_LOGINS would).
	const sessions = new Map<string, { login: string; admin: boolean }>();
	let allowlisted = false;
	let adminFlag = false;
	// Wave 8: when armed, the OAuth routes answer exactly like the real identity
	// worker with its GitHub credentials not installed (503 oauth_not_configured).
	let oauthDown = false;
	// Wave 11: when armed, the Cloud token door answers the typed no-identity shape.
	let cloudIdentityMissing = false;
	const requests: Array<{ login: string; note: string | null; createdAt: string; updatedAt: string }> = [];
	// The admin audit trail the real worker keeps: every allowlist write that
	// passed validation, with its requester + timestamps.
	const allowlistWrites: Array<{
		login: string;
		action: string;
		requester: string;
		requestedAt: string;
	}> = [];

	const sessionOf = (request: Request): { token: string; login: string; admin: boolean } | undefined => {
		const cookie = request.headers.get("cookie") ?? "";
		const token = /stub_session=([a-z0-9-]+)/.exec(cookie)?.[1];
		if (token === undefined) return undefined;
		const session = sessions.get(token);
		return session === undefined ? undefined : { token, ...session };
	};

	const server: Server<undefined> = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			// The real worker refuses a browser origin it does not serve outright
			// (localhost is always allowed), so the double does too.
			const origin = request.headers.get("origin");
			if (url.pathname.startsWith("/api/") && origin !== null && !originAllowed(origin, extraAllowedOrigins)) {
				return json(403, { error: "Forbidden origin" });
			}
			if (url.pathname === "/healthz") {
				return json(200, {
					ok: true,
					oauth: true,
					session: true,
					serviceToken: true,
					admin: true,
					testMode: true,
					requestedScopes: ["read:user", "repo"],
				});
			}
			// Test controls: not part of the contract, unreachable through the product Worker.
			if (url.pathname === "/stub/allowlist" && request.method === "POST") {
				allowlisted = true;
				return json(200, { status: "ok", allowlisted });
			}
			if (url.pathname === "/stub/no-cloud-identity" && request.method === "POST") {
				cloudIdentityMissing = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/cloud-identity" && request.method === "POST") {
				cloudIdentityMissing = false;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/make-admin" && request.method === "POST") {
				adminFlag = true;
				return json(200, { status: "ok", admin: adminFlag });
			}
			if (url.pathname === "/stub/oauth-down" && request.method === "POST") {
				oauthDown = true;
				return json(200, { status: "ok", oauthDown });
			}
			if (url.pathname === "/stub/oauth-up" && request.method === "POST") {
				oauthDown = false;
				return json(200, { status: "ok", oauthDown });
			}
			if (url.pathname === "/stub/requests" && request.method === "GET") {
				return json(200, { requests });
			}
			if (url.pathname === "/stub/allowlist-writes" && request.method === "GET") {
				return json(200, { writes: allowlistWrites });
			}
			// The admin surface: 404 — never 401/403 — without the admin token,
			// exactly like the landed worker's non-enumerability law.
			if (url.pathname.startsWith("/api/identity/admin/")) {
				if (request.headers.get("x-smithers-admin-token") !== STUB_ADMIN_TOKEN) {
					return json(404, { error: "Not found" });
				}
				if (url.pathname === "/api/identity/admin/allowlist" && request.method === "POST") {
					const body = (await request.json().catch(() => null)) as {
						login?: unknown;
						action?: unknown;
						requester?: unknown;
						timestamp?: unknown;
					} | null;
					const login = typeof body?.login === "string" ? body.login.trim() : "";
					const action = body?.action;
					if (login === "" || (action !== "add" && action !== "remove")) {
						return json(400, { error: "login and action (add|remove) are required" });
					}
					if (typeof body?.requester !== "string" || body.requester.trim() === "") {
						return json(400, { error: "requester is required", code: "requester_required" });
					}
					if (typeof body?.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp))) {
						return json(400, { error: "timestamp is required", code: "timestamp_required" });
					}
					allowlistWrites.push({
						login,
						action,
						requester: body.requester,
						requestedAt: new Date(Date.parse(body.timestamp)).toISOString(),
					});
					return json(201, {
						applied: true,
						action,
						login,
						requester: body.requester,
						requestedAt: new Date(Date.parse(body.timestamp)).toISOString(),
						recordedAt: new Date().toISOString(),
					});
				}
				if (url.pathname === "/api/identity/admin/requests" && request.method === "GET") {
					return json(200, { requests });
				}
				return json(404, { error: "Not found" });
			}
			if (url.pathname === "/api/auth/scopes" && request.method === "GET") {
				return json(200, IDENTITY_SCOPES);
			}
			if (url.pathname === "/api/auth/github/start" && request.method === "GET") {
				if (oauthDown) {
					return json(503, {
						error:
							"GitHub sign-in is not configured — the OAuth App credentials are not installed on the identity service.",
						code: "oauth_not_configured",
					});
				}
				// A double for the GitHub OAuth screen: bounces straight to the callback.
				return new Response(null, {
					status: 302,
					headers: { location: `/api/auth/github/callback?code=stub-code&state=stub-state` },
				});
			}
			if (url.pathname === "/api/auth/github/callback" && request.method === "GET") {
				if (oauthDown) {
					return json(503, {
						error: "GitHub sign-in could not complete — the identity service hit an upstream error.",
						code: "oauth_callback_failed",
					});
				}
				const token = crypto.randomUUID();
				sessions.set(token, { login: "will", admin: false });
				return new Response(null, {
					status: 302,
					headers: { location: "/", "set-cookie": `stub_session=${token}; HttpOnly; Path=/; SameSite=Lax` },
				});
			}
			if (url.pathname === "/api/auth/session" && request.method === "GET") {
				const session = sessionOf(request);
				if (session === undefined) return json(401, { status: "error", message: "signed out" });
				return json(200, { login: session.login, allowlisted, admin: adminFlag });
			}
			if (url.pathname === "/api/auth/logout" && request.method === "POST") {
				const session = sessionOf(request);
				if (session !== undefined) sessions.delete(session.token);
				return json(200, { status: "ok" }, { "set-cookie": "stub_session=; HttpOnly; Path=/; Max-Age=0" });
			}
			if (url.pathname === "/api/identity/validate" && request.method === "POST") {
				const session = sessionOf(request);
				if (session === undefined) return json(401, { status: "error", message: "no session" });
				return json(200, { login: session.login, allowlisted, admin: adminFlag, scopes: ["billing:read"] });
			}
			if (url.pathname === "/api/identity/request-access" && request.method === "POST") {
				const session = sessionOf(request);
				if (session === undefined) return json(401, { status: "error", message: "no session" });
				// Idempotent per login: repeat requests confirm, never duplicate.
				if (!requests.some((entry) => entry.login === session.login)) {
					const now = new Date().toISOString();
					requests.push({ login: session.login, note: null, createdAt: now, updatedAt: now });
				}
				return json(200, { status: "requested" });
			}
			/*
			 * Wave 11b — the per-user Cloud token door. Service-token only, by
			 * login; a missing Cloud identity is the typed honest shape
			 * ({found:false, cloud:{status}}), never a fabricated token.
			 * /stub/no-cloud-identity arms that state.
			 */
			if (url.pathname === "/api/identity/cloud-token" && request.method === "POST") {
				if (request.headers.get("x-smithers-service-token") !== "stub-service-token") {
					return json(401, { error: "Unauthorized service" });
				}
				const body = (await request.json().catch(() => ({}))) as { login?: string };
				if (typeof body.login !== "string" || body.login === "") {
					return json(400, { error: "login is required" });
				}
				if (cloudIdentityMissing) {
					return json(200, {
						valid: true,
						login: body.login,
						found: false,
						cloud: { status: "no_github_token", reason: null, attemptedAt: new Date().toISOString() },
					});
				}
				return json(200, {
					valid: true,
					login: body.login,
					found: true,
					token: STUB_CLOUD_TOKEN,
					tokenId: "8284",
					storedAt: new Date().toISOString(),
				});
			}
			return json(404, { status: "error", message: `identity stub: no route ${url.pathname}` });
		},
	});
	return { port: listeningPort(server), stop: () => server.stop(true) };
};

/* ------------------------------------------------------------------ */
/* Billing stub — shapes: flows/ui workers/billing BalanceOverview     */
/* ------------------------------------------------------------------ */

export const createStubBilling = (extraAllowedOrigins: ReadonlyArray<string> = []): StubHandle => {
	/*
	 * Wave 13: accounts are keyed per login, like the real worker's canonical
	 * account key — the bearer path keys by its (context) user id, the
	 * trusted-caller path by the normalized x-user-login. A fresh account
	 * holds the $500 design-partner grant.
	 */
	interface StubAccount {
		totalUsd: string;
		chargeCount: number;
	}
	const accounts = new Map<string, StubAccount>();
	const accountFor = (key: string): StubAccount => {
		const existing = accounts.get(key);
		if (existing !== undefined) return existing;
		const created: StubAccount = { totalUsd: "500", chargeCount: 0 };
		accounts.set(key, created);
		return created;
	};
	let lastChargeUsd = "0.05375";
	let lastBalanceAuth: { mode: "trusted" | "bearer"; account: string } | null = null;
	const grants: Array<Record<string, unknown>> = [];

	const server: Server<undefined> = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz") {
				return json(200, {
					ok: true,
					stripe: false,
					metering: true,
					adminGrants: true,
					accountingSerializable: true,
					ratesConfigured: true,
					rateCardVersion: "stub-2026-08-08",
					unpricedResources: 0,
					unpricedActiveResources: 0,
					resources: 11,
				});
			}
			// Test controls.
			if (url.pathname === "/stub/drain" && request.method === "POST") {
				for (const account of accounts.values()) account.totalUsd = "0";
				return json(200, { status: "ok", totalUsd: "0" });
			}
			if (url.pathname === "/stub/charge" && request.method === "POST") {
				for (const account of accounts.values()) {
					account.chargeCount += 1;
					account.totalUsd = "499.94625";
				}
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/last-auth" && request.method === "GET") {
				return json(200, { lastBalanceAuth });
			}
			if (url.pathname === "/stub/grants" && request.method === "GET") {
				return json(200, { grants });
			}
			/*
			 * The admin grant route (workers/billing POST /api/billing/admin/grants):
			 * its own service token — never the account bearer — opens it, and
			 * every grant must carry requester + timestamp or it's a 400, exactly
			 * like the landed contract.
			 */
			if (url.pathname === "/api/billing/admin/grants" && request.method === "POST") {
				if (request.headers.get("x-smithers-admin-token") !== STUB_ADMIN_TOKEN) {
					return json(401, { error: "Unauthorized admin" });
				}
				const body = (await request.json().catch(() => null)) as {
					userId?: unknown;
					grantId?: unknown;
					amountUsd?: unknown;
					requester?: unknown;
					timestamp?: unknown;
				} | null;
				const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
				const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
				const amountUsd = typeof body?.amountUsd === "number" ? body.amountUsd : Number.NaN;
				if (userId === "") return json(400, { error: "userId is required" });
				if (!/^admin:[A-Za-z0-9._:-]{3,190}$/.test(grantId)) {
					return json(400, { error: "grantId is required and must be a stable `admin:`-prefixed id" });
				}
				if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
					return json(400, { error: "amountUsd must be a positive number of dollars" });
				}
				if (typeof body?.requester !== "string" || body.requester.trim() === "") {
					return json(400, { error: "requester is required", code: "requester_required" });
				}
				if (typeof body?.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp))) {
					return json(400, { error: "timestamp is required", code: "timestamp_required" });
				}
				const grant = {
					granted: true,
					grantId,
					userId,
					kind: "promotional",
					amountUsd,
					requester: body.requester,
					requestedAt: new Date(Date.parse(body.timestamp)).toISOString(),
					recordedAt: new Date().toISOString(),
					expiresAt: null,
				};
				grants.push(grant);
				return json(201, grant);
			}
			/*
			 * The real contract, both authenticated paths (wave 5 / wave 13): an
			 * allowed browser origin, then EITHER the trusted-caller pair
			 * (`x-smithers-service-token` + a well-formed `x-user-login`, keyed
			 * by the normalized login) OR the Smithers Cloud user bearer. A
			 * client-supplied login without the token opens nothing.
			 */
			let accountKey: string;
			if (url.pathname.startsWith("/api/billing/")) {
				const origin = request.headers.get("origin");
				if (origin === null || !originAllowed(origin, extraAllowedOrigins)) {
					return json(403, { error: "Forbidden origin" });
				}
				const serviceToken = request.headers.get("x-smithers-service-token");
				const presentedLogin = (request.headers.get("x-user-login") ?? "").trim();
				if (
					serviceToken === STUB_PRODUCT_TOKEN &&
					/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(presentedLogin)
				) {
					accountKey = presentedLogin.toLowerCase();
					lastBalanceAuth = { mode: "trusted", account: accountKey };
				} else if (request.headers.get("authorization") === `Bearer ${STUB_BILLING_BEARER}`) {
					accountKey = request.headers.get("x-user-id") ?? "will";
					lastBalanceAuth = { mode: "bearer", account: accountKey };
				} else {
					return json(401, { error: "Unauthorized" });
				}
			} else {
				accountKey = "will";
			}
			const account = accountFor(accountKey);
			const { totalUsd, chargeCount } = account;
			const userId = accountKey;
			if (url.pathname === "/api/billing/balance" && request.method === "GET") {
				const empty = totalUsd === "0";
				return json(200, {
					user: userId,
					balance: {
						totalUsd,
						totalNanos: 0,
						promotionalUsd: totalUsd,
						purchasedUsd: "0",
						promotionalExpiresAt: null,
						promotionalExpired: false,
						lifetimeChargedUsd: chargeCount === 0 ? "0" : lastChargeUsd,
						chargeCount,
					},
					state: empty ? "empty" : "ok",
					allowedToStartWork: !empty,
					credits: empty
						? []
						: [
								{
									id: "admin:launch-grant",
									kind: "promotional",
									grantedUsd: "500",
									consumedUsd: chargeCount === 0 ? "0" : lastChargeUsd,
									remainingUsd: totalUsd,
									createdAt: new Date(0).toISOString(),
									expiresAt: null,
									source: "admin",
									requestedBy: "will@tevm.tech",
									requestedAt: new Date(0).toISOString(),
								},
							],
					rateCardVersion: "stub-2026-08-08",
					free: true,
				});
			}
			if (url.pathname === "/api/billing/usage" && request.method === "GET") {
				const runId = url.searchParams.get("run") ?? "";
				return json(200, {
					runId,
					charges: chargeCount === 0 ? [] : [{ chargeId: "stub-charge-1", amountUsd: lastChargeUsd }],
					totalNanos: 0,
					totalUsd: chargeCount === 0 ? "0" : lastChargeUsd,
					rateCardVersion: "stub-2026-08-08",
					free: true,
				});
			}
			return json(404, { status: "error", message: `billing stub: no route ${url.pathname}` });
		},
	});
	return { port: listeningPort(server), stop: () => server.stop(true) };
};

/* ------------------------------------------------------------------ */
/* Gateway double — contracts: the static /v1/rpc/submitApproval seam  */
/* (waves 6–10) AND, from wave 11, the Smithers Cloud RELAY shapes:    */
/* POST /api/repos/{owner}/{repo}/gateway (provision-or-resume) plus a */
/* per-gateway surface at /api/gateways/{id}/v1/… — the exact wire the */
/* WAVE4-RELAY and WAVE11B-CLOUD-IDENTITY receipts recorded.           */
/* ------------------------------------------------------------------ */

/** The Cloud identity token the wave-11b door hands back (never a real one). */
export const STUB_CLOUD_TOKEN = "smithers_pat_stub-cloud-identity";
/** The operator token a provisioned gateway carries (never a real one). */
export const STUB_GATEWAY_TOKEN = "smithers_gateway_stub-operator-token";

export const createStubGateway = (): StubHandle => {
	let failNext = false;
	let lastApproval: { headers: Record<string, string>; body: unknown } | undefined;

	/*
	 * Wave 11 relay state. `provisions` counts POSTs to the provision route so
	 * a test can prove idempotency (a warm resume is not a new gateway) and
	 * that no taxonomy branch retry-loops. `capacity` / `provisioningOnce` arm
	 * the §5 500-no_capacity and 409-still-provisioning answers.
	 */
	let provisions = 0;
	let gatewaySerial = 1;
	let capacity = true;
	let provisioningOnce = false;
	/*
	 * Wave 12 controls. `cloudRepo` off answers the provision route 404 — a
	 * watched GitHub repo with no Smithers Cloud counterpart (§4). `stalled`
	 * launches runs that start and then never move again — the run the
	 * workspace never finishes (§3), which is what a credential-less
	 * create-workflow run actually looks like from the outside.
	 */
	let cloudRepo = true;
	let stalled = false;
	/* How many times the client has read a run's event stream (§3 proof). */
	let eventReads = 0;
	const gateways = new Map<string, { repo: string; token: string }>();
	// One scripted run per launch: events accrue with monotonic seq, exactly
	// like the engine's run_events, and the run parks on its approval gate
	// until a submitApproval auto-resumes it (wave-4's proven behaviour).
	interface StubRun {
		runId: string;
		workflow: string;
		input: unknown;
		status: string;
		blocked: { kind: string; nodeId: string } | null;
		events: Array<{ runId: string; seq: number; event: string; payload: unknown; timestampMs: number }>;
	}
	const runs = new Map<string, StubRun>();
	let runSerial = 1;
	const workflows = [
		{ key: "create-workflow", description: "Build a new Smithers workflow from a plain-English ask." },
		{ key: "wave4-relay-proof", description: "Three nodes with an approval gate." },
	];

	const emit = (run: StubRun, event: string, payload: unknown = {}): void => {
		run.events.push({
			runId: run.runId,
			seq: run.events.length + 1,
			event,
			payload,
			timestampMs: Date.now(),
		});
	};

	const rpc = (method: string, params: Record<string, unknown>): Response => {
		switch (method) {
			case "listWorkflows":
				return json(200, { ok: true, apiVersion: "v1", payload: workflows });
			case "launchRun": {
				const workflow = String(params.workflow ?? "");
				if (!workflows.some((entry) => entry.key === workflow)) {
					return json(200, { ok: false, error: { code: "NOT_FOUND", message: `Unknown workflow: ${workflow}` } });
				}
				const runId = `stub-run-${runSerial++}`;
				const run: StubRun = {
					runId,
					workflow,
					input: params.input,
					status: "running",
					blocked: null,
					events: [],
				};
				runs.set(runId, run);
				emit(run, "RunStarted");
				emit(run, "NodeStarted", { nodeId: "clarify" });
				// §3: a stalled run starts and is never heard from again, while
				// getRun keeps answering "running" — the live wave-11 shape.
				if (stalled) {
					return json(200, { ok: true, apiVersion: "v1", payload: { runId, workflow, system: false } });
				}
				// The gate arrives on the next poll, so the client genuinely
				// watches a run move from running → waiting-approval.
				setTimeout(() => {
					emit(run, "NodeFinished", { nodeId: "clarify" });
					emit(run, "ApprovalRequested", { nodeId: "gate" });
					run.status = "waiting-approval";
					run.blocked = { kind: "approval", nodeId: "gate" };
				}, 300);
				return json(200, { ok: true, apiVersion: "v1", payload: { runId, workflow, system: false } });
			}
			case "getRun": {
				const run = runs.get(String(params.runId ?? ""));
				if (run === undefined) return json(200, { ok: false, error: { code: "NOT_FOUND", message: "no run" } });
				return json(200, {
					ok: true,
					apiVersion: "v1",
					payload: {
						runId: run.runId,
						status: run.status,
						runState: { state: run.status, blocked: run.blocked },
						errorJson: null,
					},
				});
			}
			case "listApprovals": {
				const filter = (params.filter ?? {}) as { runId?: string };
				const run = runs.get(String(filter.runId ?? params.runId ?? ""));
				if (run?.blocked == null) return json(200, { ok: true, apiVersion: "v1", payload: [] });
				return json(200, {
					ok: true,
					apiVersion: "v1",
					payload: [
						{
							runId: run.runId,
							nodeId: run.blocked.nodeId,
							iteration: 0,
							requestTitle: "Open a pull request with the new workflow",
							requestSummary: "This pushes a branch and opens a PR on your repository.",
							approvalMode: "decision",
							requestedAtMs: Date.now(),
						},
					],
				});
			}
			case "submitApproval": {
				const run = runs.get(String(params.runId ?? ""));
				if (run === undefined) return json(200, { ok: false, error: { code: "NOT_FOUND", message: "no run" } });
				lastApproval = { headers: {}, body: params };
				emit(run, "NodeFinished", { nodeId: String(params.nodeId ?? "") });
				run.blocked = null;
				run.status = "running";
				// Auto-resume with no further input (the wave-4 proven behaviour).
				setTimeout(() => {
					emit(run, "NodeFinished", { nodeId: "document" });
					emit(run, "RunFinished");
					run.status = "finished";
				}, 300);
				return json(200, { ok: true, apiVersion: "v1", payload: { ...params, approved: true } });
			}
			case "whatHappened":
				return json(200, {
					ok: true,
					apiVersion: "v1",
					payload: {
						runId: String(params.runId ?? ""),
						nodeId: null,
						iteration: null,
						scope: "run",
						summary:
							"I built `summarize-open-issues` and opened a pull request with it — it reads your open issues and writes one digest.",
						agentId: null,
						source: "facts",
						cached: false,
						generatedAtMs: Date.now(),
					},
				});
			default:
				return json(200, { ok: false, error: { code: "NOT_FOUND", message: `no method ${method}` } });
		}
	};

	const server: Server<undefined> = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/stub/fail-approval" && request.method === "POST") {
				failNext = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/last-approval" && request.method === "GET") {
				return json(200, lastApproval ?? null);
			}
			/* Wave 11 relay controls. */
			if (url.pathname === "/stub/no-capacity" && request.method === "POST") {
				capacity = false;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/capacity" && request.method === "POST") {
				capacity = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/provisioning-once" && request.method === "POST") {
				provisioningOnce = true;
				return json(200, { status: "ok" });
			}
			/* Wave 12 controls (§3 stalled runs, §4 no Cloud counterpart). */
			if (url.pathname === "/stub/stalled-runs" && request.method === "POST") {
				stalled = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/lively-runs" && request.method === "POST") {
				stalled = false;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/no-cloud-repo" && request.method === "POST") {
				cloudRepo = false;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/cloud-repo" && request.method === "POST") {
				cloudRepo = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/relay-state" && request.method === "GET") {
				return json(200, {
					provisions,
					eventReads,
					gateways: [...gateways.keys()],
					runs: [...runs.values()].map((run) => ({
						runId: run.runId,
						workflow: run.workflow,
						input: run.input,
						status: run.status,
						events: run.events.length,
					})),
				});
			}

			/*
			 * Provision-or-resume (§5). Idempotent: a warm resume returns the
			 * SAME gateway_id and token with a fresh expires_at. The taxonomy is
			 * distinct — 409 while provisioning, 500 no_capacity when the pool
			 * is exhausted.
			 */
			const provision = /^\/api\/repos\/([^/]+\/[^/]+)\/gateway$/.exec(url.pathname);
			if (provision !== null && request.method === "POST") {
				provisions += 1;
				if (request.headers.get("authorization") !== `Bearer ${STUB_CLOUD_TOKEN}`) {
					return new Response("unauthorized", { status: 401 });
				}
				if (!cloudRepo) {
					return json(404, { error: "not_found", message: "repository not found on Smithers Cloud" });
				}
				if (!capacity) {
					return json(500, { error: "no_capacity", message: "no worker has capacity for a new sandbox" });
				}
				if (provisioningOnce) {
					provisioningOnce = false;
					return new Response("repo gateway provisioning is still in progress", { status: 409 });
				}
				const repo = provision[1] ?? "";
				let id = [...gateways.entries()].find(([, entry]) => entry.repo === repo)?.[0];
				if (id === undefined) {
					id = `gw-${gatewaySerial++}`;
					gateways.set(id, { repo, token: STUB_GATEWAY_TOKEN });
				}
				return json(200, {
					base_url: `http://127.0.0.1:${listeningPort(server)}/api/gateways/${id}`,
					token: gateways.get(id)?.token,
					expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					gateway_id: id,
					vm_id: `msb_${id}`,
					status: "running",
				});
			}

			/* The per-gateway relay surface. Auth is closed: bearer or 401. */
			const relay = /^\/api\/gateways\/([^/]+)(\/.*)$/.exec(url.pathname);
			if (relay !== null) {
				const entry = gateways.get(relay[1] ?? "");
				if (entry === undefined || request.headers.get("authorization") !== `Bearer ${entry.token}`) {
					return json(401, { message: "invalid gateway credentials" });
				}
				const path = relay[2] ?? "";
				const rpcMethod = /^\/v1\/rpc\/(.+)$/.exec(path)?.[1];
				if (rpcMethod !== undefined && request.method === "POST") {
					const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
					if (rpcMethod === "submitApproval" && failNext) {
						failNext = false;
						return json(500, { error: "Internal", message: "stub gateway forced failure" });
					}
					return rpc(rpcMethod, params);
				}
				// GET /v1/api/runs/{runId}/events?afterSeq= — the REST projection
				// of streamRunEvents, envelope {ok:true, data:[…]}.
				const events = /^\/v1\/api\/runs\/([^/]+)\/events$/.exec(path);
				if (events !== null && request.method === "GET") {
					const run = runs.get(decodeURIComponent(events[1] ?? ""));
					// Wave 12 §3: the count a caller reads back to prove the client's
					// pump actually STOPPED, rather than merely repainting the card.
					eventReads += 1;
					const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
					return json(200, { ok: true, data: (run?.events ?? []).filter((row) => row.seq > afterSeq) });
				}
				if (path === "/v1/api/stream" && request.method === "GET") {
					// The change stream, with the monotonic ids Last-Event-ID resumes from.
					return new Response(`id: 1\nevent: change\ndata: {"seq":1,"collections":["run_events"]}\n\n`, {
						status: 200,
						headers: {
							"content-type": "text/event-stream; charset=utf-8",
							"x-accel-buffering": "no",
						},
					});
				}
				return json(404, { status: "error", message: `gateway stub: no relay route ${path}` });
			}
			if (url.pathname === "/v1/rpc/submitApproval" && request.method === "POST") {
				const body = (await request.json()) as {
					runId: string;
					nodeId: string;
					iteration: number;
					decision: { approved: boolean; note?: string };
				};
				lastApproval = {
					headers: {
						"x-user-id": request.headers.get("x-user-id") ?? "",
						authorization: request.headers.get("authorization") ?? "",
					},
					body,
				};
				if (failNext) {
					failNext = false;
					return json(500, { error: "Internal", message: "stub gateway forced failure" });
				}
				return json(200, {
					runId: body.runId,
					nodeId: body.nodeId,
					iteration: body.iteration,
					approved: body.decision.approved,
				});
			}
			return json(404, { status: "error", message: `gateway stub: no route ${url.pathname}` });
		},
	});
	return { port: listeningPort(server), stop: () => server.stop(true) };
};

/* ------------------------------------------------------------------ */
/* Reco stub — shapes: flows/ui workers/recommendations (WAVE3-RECO)   */
/* ------------------------------------------------------------------ */

/**
 * The recommendations double: the grounded first-run answer (digest + the ONE
 * ranked recommendation), the feedback log every accept/edit/dismiss lands in,
 * the admin feedback read (404-never-403 without the admin token), and a
 * /stub/degrade control that switches first-run to a degraded honest answer.
 */
export const createStubReco = (extraAllowedOrigins: ReadonlyArray<string> = []): StubHandle => {
	let degraded = false;
	const feedbackLog: Array<{ at: string; action: string; recommendationId: string; evidenceKey: string | null }> =
		[];

	/*
	 * Wave 10 — the watched-repos contract: the stub honors the landed
	 * wave-10b routes. `selected: null` = never chosen (needsSelection, with
	 * the candidates inline); [] = deliberately chose none (emptySelection);
	 * a chosen set scopes the digest to exactly those repos.
	 */
	let watched: { selected: string[]; selectedAt: string; via: string } | null = null;
	const candidates = [
		{ fullName: "will/flows", private: false, pushedAt: "2026-08-07T12:00:00.000Z", openIssues: 4 },
		{ fullName: "will/smithers", private: false, pushedAt: "2026-08-06T09:00:00.000Z", openIssues: 2 },
		{ fullName: "will/mvp", private: true, pushedAt: "2026-08-05T18:00:00.000Z", openIssues: 1 },
	];

	const grounded = (repos: ReadonlyArray<string>) => {
		const considered = repos.length;
		return {
			degraded: false,
			cached: false,
			watched: [...repos],
			digest: {
				login: "will",
				computedAt: "2026-08-08T09:00:00.000Z",
				reposConsidered: considered,
				openIssues: considered * 2,
				openPullRequests: considered > 1 ? 2 : 0,
				staleCount: considered,
				mostActiveRepo: { name: repos[0] ?? "will/flows", pushedAt: "2026-08-07T12:00:00.000Z" },
				oldestWaiting: {
					kind: "pr",
					repo: repos[0] ?? "will/flows",
					number: 12,
					title: "Wire the sync adapter",
					url: `https://github.com/${repos[0] ?? "will/flows"}/pull/12`,
					updatedAt: "2026-07-28T10:00:00.000Z",
					waitingDays: 11,
				},
				untriagedInMostActive: considered,
				sentence: `You have ${considered * 2} open issues across ${considered} repo${
					considered === 1 ? "" : "s"
				}; the oldest has waited 11 days.`,
			},
			recommendation: {
				id: `review-pr:${repos[0] ?? "will/flows"}#12`,
				type: "review-pr",
				rank: 1,
				title: `Review "Wire the sync adapter" in ${repos[0] ?? "will/flows"}`,
				proposes: `Open pull request #12 ("Wire the sync adapter") in ${repos[0] ?? "will/flows"} for review.`,
				whyNow: "It is the oldest pull request waiting on you — untouched for 11 days.",
				whatHappens:
					"Smithers opens the diff for this pull request and walks it with you; nothing is merged or closed until you say so.",
				subject: {
					kind: "pr",
					repo: repos[0] ?? "will/flows",
					number: 12,
					title: "Wire the sync adapter",
					url: `https://github.com/${repos[0] ?? "will/flows"}/pull/12`,
					updatedAt: "2026-07-28T10:00:00.000Z",
				},
				evidence: {
					subjectUpdatedAt: "2026-07-28T10:00:00.000Z",
					openIssues: considered * 2,
					openPullRequests: considered > 1 ? 2 : 0,
					staleCount: considered,
					untriagedInMostActive: considered,
					watchedCount: considered,
				},
				evidenceKey: "0123456789abcdef",
				affordances: {
					accept: { label: "Do it", command: "reco.feedback accept" },
					edit: { label: "Edit first", command: "reco.feedback edit" },
					dismiss: { label: "Not now", command: "reco.feedback dismiss" },
				},
			},
		};
	};

	const sessionOk = (request: Request): boolean => {
		const cookie = request.headers.get("cookie");
		return cookie !== null && cookie.includes("stub_session=");
	};

	const server: Server<undefined> = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			// The real worker refuses a disallowed present origin (localhost always allowed).
			const origin = request.headers.get("origin");
			if (url.pathname.startsWith("/api/") && origin !== null && !originAllowed(origin, extraAllowedOrigins)) {
				return json(403, { error: "Forbidden origin" });
			}
			if (url.pathname === "/healthz") {
				return json(200, { ok: true, identity: true, prewarm: false, admin: true, testMode: true });
			}
			// Test controls.
			if (url.pathname === "/stub/degrade" && request.method === "POST") {
				degraded = true;
				return json(200, { status: "ok", degraded });
			}
			if (url.pathname === "/stub/undegrade" && request.method === "POST") {
				degraded = false;
				return json(200, { status: "ok", degraded });
			}
			if (url.pathname === "/stub/feedback" && request.method === "GET") {
				return json(200, { entries: feedbackLog });
			}
			if (url.pathname === "/stub/watched" && request.method === "GET") {
				return json(200, { watched });
			}
			if (url.pathname === "/stub/clear-selection" && request.method === "POST") {
				watched = null;
				return json(200, { status: "ok" });
			}
			// The admin surface: 404 — never 403 — without the admin token.
			if (url.pathname === "/api/reco/admin/feedback" && request.method === "GET") {
				if (request.headers.get("x-smithers-admin-token") !== STUB_ADMIN_TOKEN) {
					return json(404, { error: "Not found" });
				}
				return json(200, {
					all: feedbackLog.length === 0 ? [] : [{ login: "will", entries: feedbackLog }],
				});
			}
			if (url.pathname === "/api/reco/repos" && request.method === "GET") {
				if (!sessionOk(request)) return json(401, { error: "Unauthorized" });
				return json(200, { candidates, cached: false });
			}
			if (url.pathname === "/api/reco/watched" && request.method === "GET") {
				if (!sessionOk(request)) return json(401, { error: "Unauthorized" });
				return json(200, {
					selected: watched?.selected ?? null,
					selectedAt: watched?.selectedAt ?? null,
					via: watched?.via ?? null,
				});
			}
			if (url.pathname === "/api/reco/watched" && request.method === "PUT") {
				if (!sessionOk(request)) return json(401, { error: "Unauthorized" });
				const body = (await request.json().catch(() => null)) as {
					selected?: unknown;
					via?: unknown;
				} | null;
				if (!Array.isArray(body?.selected) || !body.selected.every((name) => typeof name === "string")) {
					return json(400, { error: "selected must be an array of repo full names", code: "invalid_selection" });
				}
				const unknown = body.selected.filter(
					(name) => !candidates.some((candidate) => candidate.fullName === name),
				);
				if (unknown.length > 0) {
					return json(400, { error: "unknown repositories", code: "unknown_repos", unknown });
				}
				const via =
					body.via === "command" || body.via === "agent" || body.via === "onboarding"
						? body.via
						: "onboarding";
				watched = { selected: [...body.selected], selectedAt: new Date().toISOString(), via };
				return json(200, { selected: watched.selected, selectedAt: watched.selectedAt, via: watched.via });
			}
			if (url.pathname === "/api/reco/first-run" && request.method === "GET") {
				if (!sessionOk(request)) {
					return json(401, { error: "Unauthorized" });
				}
				if (degraded) {
					return json(200, {
						degraded: true,
						reason: "github_rate_limited",
						honestMessage:
							"GitHub is rate-limiting reads right now, so I couldn't read your work — ask me anything and we'll start from here.",
					});
				}
				if (watched === null) {
					return json(200, { needsSelection: true, candidates, cached: false });
				}
				if (watched.selected.length === 0) {
					return json(200, {
						emptySelection: true,
						digest: null,
						recommendation: null,
						honestMessage:
							"You're watching no repositories right now — ask me to watch some and we'll start from there.",
					});
				}
				return json(200, grounded(watched.selected));
			}
			if (url.pathname === "/api/reco/feedback" && request.method === "POST") {
				const cookie = request.headers.get("cookie");
				if (cookie === null || !cookie.includes("stub_session=")) {
					return json(401, { error: "Unauthorized" });
				}
				const body = (await request.json().catch(() => null)) as {
					recommendationId?: unknown;
					action?: unknown;
					evidenceKey?: unknown;
				} | null;
				if (typeof body?.recommendationId !== "string" || body.recommendationId === "") {
					return json(400, { error: "recommendationId is required", code: "recommendation_required" });
				}
				if (body.action !== "accept" && body.action !== "edit" && body.action !== "dismiss") {
					return json(400, { error: "action must be accept, edit, or dismiss", code: "invalid_action" });
				}
				feedbackLog.push({
					at: new Date().toISOString(),
					action: body.action,
					recommendationId: body.recommendationId,
					evidenceKey: typeof body.evidenceKey === "string" ? body.evidenceKey : null,
				});
				return json(201, { recorded: true, action: body.action, recommendationId: body.recommendationId });
			}
			return json(404, { status: "error", message: `reco stub: no route ${url.pathname}` });
		},
	});
	return { port: listeningPort(server), stop: () => server.stop(true) };
};

/* Standalone mode: print the --var lines for `bun run serve:local`. */
if (import.meta.main) {
	const identity = createStubIdentity();
	const billing = createStubBilling();
	const gateway = createStubGateway();
	const reco = createStubReco();
	console.log("TEST DOUBLES running (never deploy these). Pass to wrangler dev as:");
	console.log(`  --var IDENTITY_UPSTREAM_URL:http://127.0.0.1:${identity.port}`);
	console.log(`  --var BILLING_UPSTREAM_URL:http://127.0.0.1:${billing.port}`);
	console.log(`  --var BILLING_AUTH_TOKEN:${STUB_BILLING_BEARER}`);
	console.log(`  --var GATEWAY_UPSTREAM_URL:http://127.0.0.1:${gateway.port}`);
	console.log(`  --var IDENTITY_SERVICE_TOKEN:stub-service-token`);
	console.log(`  --var GATEWAY_SESSION_USER_ID:will`);
	console.log(`  --var RECO_UPSTREAM_URL:http://127.0.0.1:${reco.port}`);
	console.log(`  --var IDENTITY_ADMIN_TOKEN:${STUB_ADMIN_TOKEN}`);
	console.log(`  --var BILLING_ADMIN_TOKEN:${STUB_ADMIN_TOKEN}`);
	console.log(`  --var RECO_ADMIN_TOKEN:${STUB_ADMIN_TOKEN}`);
}
