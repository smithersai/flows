/**
 * TEST DOUBLES for local development and the worker e2e — never deployed.
 *
 * These stubs honor the real backend contracts so the product Worker's seams
 * can be exercised without GitHub, the identity worker, the billing worker, or
 * the engine gateway:
 *
 *   - identity: the wave2 identity-allowlist contract (/api/auth/*, /api/identity/*)
 *               including the native sign-in handoff (/api/auth/native/*), whose
 *               server half lives in the out-of-repo identity Worker — this
 *               double is the only executable statement of that contract
 *   - billing:  workers/billing's real response shapes (dollars, allowedToStartWork),
 *               with grants idempotent by grantId
 *   - gateway:  the engine gateway's submitApproval RPC echo, the Smithers Cloud
 *               relay (provision + per-gateway surface), and the platform-proxy
 *               families the Worker's PLATFORM_PROXY_RULES forward upstream
 *   - reco:     the recommendations worker, including the dismissal window
 *
 * Every double models the parts of its contract a client can get WRONG —
 * expiry, single use, idempotency, cursors, ordering. A control that only
 * echoes what the suite asked for proves nothing, so none of them do that.
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
	// Stub state defaults to "will" (a placeholder handle, never a real
	// account). Personas may replace it through the stub-only control.
	const sessions = new Map<string, { login: string; admin: boolean }>();
	let allowlisted = false;
	let adminFlag = false;
	let personaLogin = "will";
	let personaHistory: "never" | "established" = "established";
	// Wave 8: when armed, the OAuth routes answer exactly like the real identity
	// worker with its GitHub credentials not installed (503 oauth_not_configured).
	let oauthDown = false;
	// Wave 11: when armed, the Cloud token door answers the typed no-identity shape.
	let cloudIdentityMissing = false;
	/*
	 * The native sign-in handoff (device-flow style). The webview has no
	 * platform authenticator, so OAuth runs in the SYSTEM browser: start mints
	 * a one-time handoff, the browser tab completes the callback bound to it,
	 * and the app polls the claim same-origin until the session cookie lands in
	 * its own jar. A claim is single-use and it expires; both spend the same
	 * 404 the client reads as "that sign-in expired", so nothing about a
	 * handoff is enumerable from the wire.
	 */
	const HANDOFF_TTL_MS = 600_000;
	interface StubHandoff {
		pollSecret: string;
		expiresAt: number;
		state: "pending" | "ready" | "failed";
		token: string | null;
		message: string | null;
	}
	const handoffs = new Map<string, StubHandoff>();
	/*
	 * Consumed and expired handoffs, kept for the CONTROL plane only. The wire
	 * answer stays a bare 404; a suite reads this to prove the second claim was
	 * refused because the handoff was spent, not because the double 404s
	 * everything.
	 */
	const spentHandoffs = new Map<string, "consumed" | "expired" | "failed">();
	/** Every claim the double answered, so a replay is provable, not inferred. */
	const claimLog: Array<{ at: string; handoffId: string; outcome: string; status: number }> = [];
	/** The last claim that handed a session over, for the /stub/replay-claim control. */
	let lastReadyClaim: { handoffId: string; pollSecret: string } | null = null;
	// When armed, the next handoff-bound callback records a FAILED OAuth.
	let handoffFailure: string | null = null;

	/*
	 * The claim, factored out so /stub/replay-claim can drive it server-side
	 * with the exact credentials the app used. Unknown, wrong-secret, consumed
	 * and expired are ONE answer.
	 */
	const claimHandoff = (
		handoffId: string,
		pollSecret: unknown,
	): { status: number; body: Record<string, unknown>; headers: Record<string, string>; outcome: string } => {
		const handoff = handoffs.get(handoffId);
		const gone = (outcome: string) => ({
			status: 404,
			body: { status: "error", message: "expired" },
			headers: {},
			outcome,
		});
		if (handoff === undefined) return gone(spentHandoffs.get(handoffId) ?? "unknown");
		if (handoff.pollSecret !== pollSecret) return gone("wrong-secret");
		if (handoff.expiresAt <= Date.now()) {
			handoffs.delete(handoffId);
			spentHandoffs.set(handoffId, "expired");
			return gone("expired");
		}
		if (handoff.state === "pending") {
			return { status: 200, body: { status: "pending" }, headers: {}, outcome: "pending" };
		}
		// Single use: handing the outcome over consumes the handoff.
		handoffs.delete(handoffId);
		if (handoff.state === "failed") {
			spentHandoffs.set(handoffId, "failed");
			return {
				status: 200,
				body: { status: "failed", message: handoff.message ?? "Sign-in didn't finish." },
				headers: {},
				outcome: "failed",
			};
		}
		spentHandoffs.set(handoffId, "consumed");
		return {
			status: 200,
			body: { status: "ready" },
			headers: { "set-cookie": `stub_session=${handoff.token ?? ""}; HttpOnly; Path=/; SameSite=Lax` },
			outcome: "ready",
		};
	};
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
			if (url.pathname === "/stub/persona" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as {
					login?: unknown;
					history?: unknown;
					allowlisted?: unknown;
				} | null;
				if (
					typeof body?.login !== "string" ||
					!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(body.login) ||
					(body.history !== "never" && body.history !== "established")
				) {
					return json(400, { status: "error", message: "valid login and history are required" });
				}
				personaLogin = body.login;
				personaHistory = body.history;
				allowlisted = body.allowlisted === true;
				return json(200, { status: "ok", login: personaLogin, history: personaHistory, allowlisted });
			}
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
			// Age out every live handoff, as the identity worker's TTL would.
			if (url.pathname === "/stub/expire-handoffs" && request.method === "POST") {
				const aged = handoffs.size;
				for (const handoff of handoffs.values()) handoff.expiresAt = 0;
				return json(200, { status: "ok", handoffs: aged });
			}
			// Arm the next handoff-bound callback to record a failed OAuth.
			if (url.pathname === "/stub/handoff-fail" && request.method === "POST") {
				handoffFailure = "GitHub said no.";
				return json(200, { status: "ok" });
			}
			/*
			 * Re-issue the last claim that handed a session over, with the SAME
			 * credentials. A single-use handoff must refuse it; a double that
			 * merely stored the answer would hand the session out twice.
			 */
			if (url.pathname === "/stub/replay-claim" && request.method === "POST") {
				if (lastReadyClaim === null) {
					return json(409, { status: "error", message: "no claim has handed a session over yet" });
				}
				const replay = claimHandoff(lastReadyClaim.handoffId, lastReadyClaim.pollSecret);
				claimLog.push({
					at: new Date().toISOString(),
					handoffId: lastReadyClaim.handoffId,
					outcome: `replay:${replay.outcome}`,
					status: replay.status,
				});
				return json(200, {
					status: "ok",
					replayStatus: replay.status,
					replayOutcome: replay.outcome,
					// The header is reported, never re-issued: a refused replay
					// must not put a session cookie back on the wire.
					replaySetCookie: replay.headers["set-cookie"] ?? null,
				});
			}
			if (url.pathname === "/stub/handoffs" && request.method === "GET") {
				return json(200, {
					live: [...handoffs.entries()].map(([id, handoff]) => ({
						id,
						state: handoff.state,
						expiresInMs: handoff.expiresAt - Date.now(),
					})),
					spent: [...spentHandoffs.entries()].map(([id, reason]) => ({ id, reason })),
					claims: claimLog,
				});
			}
			/*
			 * Drop every session, as a server-side expiry would: the browser
			 * still holds its cookie, the authority stops honouring it, so the
			 * next /api/identity/validate 401s.
			 */
			if (
				(url.pathname === "/stub/expire-sessions" || url.pathname === "/stub/expire-session") &&
				request.method === "POST"
			) {
				const dropped = sessions.size;
				sessions.clear();
				return json(200, { status: "ok", dropped, sessions: sessions.size });
			}
			// Return the double to its boot state so the next suite starts clean.
			if (url.pathname === "/stub/reset" && request.method === "POST") {
				sessions.clear();
				handoffs.clear();
				spentHandoffs.clear();
				claimLog.length = 0;
				requests.length = 0;
				allowlistWrites.length = 0;
				lastReadyClaim = null;
				handoffFailure = null;
				allowlisted = false;
				adminFlag = false;
				oauthDown = false;
				cloudIdentityMissing = false;
				personaLogin = "will";
				personaHistory = "established";
				return json(200, { status: "ok" });
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
				/*
				 * A double for the GitHub OAuth screen: bounces straight to the
				 * callback, carrying the native handoff binding when there is one.
				 * The real worker carries it through GitHub's `state`.
				 */
				const boundHandoff = url.searchParams.get("handoff");
				return new Response(null, {
					status: 302,
					headers: {
						location: `/api/auth/github/callback?code=stub-code&state=stub-state${
							boundHandoff === null ? "" : `&handoff=${encodeURIComponent(boundHandoff)}`
						}`,
					},
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
				/*
				 * A handoff-bound callback does NOT cookie THIS tab: the session
				 * travels to the app through the claim. The tab gets the 200 HTML
				 * success page the product Worker passes through unchanged.
				 * Replacing it with the wave-8 error surface was a live bug.
				 */
				const callbackHandoffId = url.searchParams.get("handoff");
				if (callbackHandoffId !== null) {
					const handoff = handoffs.get(callbackHandoffId);
					if (handoff === undefined || handoff.expiresAt <= Date.now()) {
						return json(404, { status: "error", message: "expired" });
					}
					if (handoffFailure !== null) {
						handoff.state = "failed";
						handoff.message = handoffFailure;
						handoffFailure = null;
					} else {
						sessions.set(token, { login: personaLogin, admin: false });
						handoff.state = "ready";
						handoff.token = token;
					}
					return new Response(
						"<!doctype html><title>Signed in</title>You're signed in — return to the Smithers app.",
						{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
					);
				}
				sessions.set(token, { login: personaLogin, admin: false });
				return new Response(null, {
					status: 302,
					headers: { location: "/", "set-cookie": `stub_session=${token}; HttpOnly; Path=/; SameSite=Lax` },
				});
			}
			/*
			 * The native handoff, start. The client reads exactly `handoffId`
			 * and `pollSecret` and requires both to be strings; `expiresAt` is
			 * stated but read by nothing, so no client behaviour may rest on it.
			 */
			if (url.pathname === "/api/auth/native/start" && request.method === "POST") {
				const handoffId = crypto.randomUUID();
				const pollSecret = crypto.randomUUID();
				const expiresAt = Date.now() + HANDOFF_TTL_MS;
				handoffs.set(handoffId, { pollSecret, expiresAt, state: "pending", token: null, message: null });
				return json(200, { handoffId, pollSecret, expiresAt });
			}
			if (url.pathname === "/api/auth/native/claim" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as
					| { handoffId?: unknown; pollSecret?: unknown }
					| null;
				const handoffId = typeof body?.handoffId === "string" ? body.handoffId : "";
				const answer = claimHandoff(handoffId, body?.pollSecret);
				claimLog.push({
					at: new Date().toISOString(),
					handoffId,
					outcome: answer.outcome,
					status: answer.status,
				});
				if (answer.outcome === "ready" && typeof body?.pollSecret === "string") {
					lastReadyClaim = { handoffId, pollSecret: body.pollSecret };
				}
				return json(answer.status, answer.body, answer.headers);
			}
			if (url.pathname === "/api/auth/session" && request.method === "GET") {
				const session = sessionOf(request);
				if (session === undefined) return json(401, { status: "error", message: "signed out" });
				return json(200, { login: session.login, allowlisted, admin: adminFlag });
			}
			/*
			 * Sign-out answers JSON, never a redirect. The client only inspects
			 * `response.ok`; `fetch` would follow a 3xx transparently and
			 * whatever it landed on would decide the outcome.
			 */
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
	interface StubPersonaGrant {
		id: string;
		kind: "promotional" | "purchased";
		amountUsd: string;
	}
	const launchGrant: StubPersonaGrant = {
		id: "admin:launch-grant",
		kind: "promotional",
		amountUsd: "500",
	};
	const accounts = new Map<string, StubAccount>();
	const accountGrants = new Map<string, ReadonlyArray<StubPersonaGrant>>();
	const accountFor = (key: string): StubAccount => {
		const existing = accounts.get(key);
		if (existing !== undefined) return existing;
		const created: StubAccount = { totalUsd: "500", chargeCount: 0 };
		accounts.set(key, created);
		accountGrants.set(key, [launchGrant]);
		return created;
	};
	let lastChargeUsd = "0.05375";
	let lastBalanceAuth: { mode: "trusted" | "bearer"; account: string } | null = null;
	const grants: Array<Record<string, unknown>> = [];
	/*
	 * The real worker is idempotent by grantId: a replayed grant is answered
	 * from the record it already wrote, marked duplicate, and credits nothing.
	 * grantId is the idempotency key, which is why the route refuses one that
	 * is not a stable `admin:`-prefixed id.
	 */
	const grantedIds = new Map<string, Record<string, unknown>>();
	/** Dollars the way the worker states them: a plain decimal string. */
	const usd = (value: number): string => String(Number(value.toFixed(5)));

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
			if (url.pathname === "/stub/persona" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as {
					login?: unknown;
					balanceUsd?: unknown;
					chargeCount?: unknown;
					grants?: unknown;
				} | null;
				const login = typeof body?.login === "string" ? body.login.toLowerCase() : "";
				const validGrants =
					Array.isArray(body?.grants) &&
					body.grants.every(
						(grant) =>
							typeof grant === "object" &&
							grant !== null &&
							typeof (grant as { id?: unknown }).id === "string" &&
							((grant as { kind?: unknown }).kind === "promotional" ||
								(grant as { kind?: unknown }).kind === "purchased") &&
							typeof (grant as { amountUsd?: unknown }).amountUsd === "string",
					);
				if (
					!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login) ||
					typeof body?.balanceUsd !== "string" ||
					!/^\d+(?:\.\d{1,5})?$/.test(body.balanceUsd) ||
					typeof body.chargeCount !== "number" ||
					!Number.isInteger(body.chargeCount) ||
					body.chargeCount < 0 ||
					!validGrants
				) {
					return json(400, { status: "error", message: "valid billing persona state is required" });
				}
				accounts.set(login, { totalUsd: body.balanceUsd, chargeCount: body.chargeCount });
				accountGrants.set(login, body.grants as ReadonlyArray<StubPersonaGrant>);
				return json(200, { status: "ok", login, balanceUsd: body.balanceUsd, chargeCount: body.chargeCount });
			}
			if (url.pathname === "/stub/drain" && request.method === "POST") {
				for (const account of accounts.values()) account.totalUsd = "0";
				return json(200, { status: "ok", totalUsd: "0" });
			}
			/*
			 * The inverse of /stub/drain. Like drain it only reaches accounts
			 * that already exist, so it answers the count it touched — a suite
			 * that refilled nothing sees zero rather than a false green.
			 */
			if (url.pathname === "/stub/refill" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { totalUsd?: unknown } | null;
				const totalUsd = typeof body?.totalUsd === "string" ? body.totalUsd : "500";
				let refilled = 0;
				for (const account of accounts.values()) {
					account.totalUsd = totalUsd;
					refilled += 1;
				}
				return json(200, { status: "ok", refilled, totalUsd });
			}
			// Return the double to its boot state so the next suite starts clean.
			if (url.pathname === "/stub/reset" && request.method === "POST") {
				accounts.clear();
				accountGrants.clear();
				grants.length = 0;
				grantedIds.clear();
				lastBalanceAuth = null;
				return json(200, { status: "ok" });
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
				/*
				 * The replay answer: the stored record, marked duplicate, 200 not
				 * 201. Nothing is credited and nothing new is written, so a
				 * client that retries a grant cannot double-credit an account.
				 */
				const replay = grantedIds.get(grantId);
				if (replay !== undefined) return json(200, { ...replay, duplicate: true });
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
				grantedIds.set(grantId, grant);
				// A grant is only real once it moves the balance the product reads.
				const credited = accountFor(userId.toLowerCase());
				credited.totalUsd = usd(Number(credited.totalUsd) + amountUsd);
				accountGrants.set(userId.toLowerCase(), [
					...(accountGrants.get(userId.toLowerCase()) ?? []),
					{ id: grantId, kind: "promotional", amountUsd: usd(amountUsd) },
				]);
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
						: (accountGrants.get(accountKey) ?? []).map((grant) => ({
								id: grant.id,
								kind: grant.kind,
								grantedUsd: grant.amountUsd,
								consumedUsd: chargeCount === 0 ? "0" : lastChargeUsd,
								remainingUsd: totalUsd,
								createdAt: new Date(0).toISOString(),
								expiresAt: null,
								source: grant.kind === "promotional" ? "admin" : "purchase",
								requestedBy: grant.kind === "promotional" ? "will@tevm.tech" : null,
								requestedAt: new Date(0).toISOString(),
							})),
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
	/*
	 * The relay tunnel and the SSE seam, failable on demand. A reconnect is
	 * only provable if the connection can actually be dropped mid-flight, so
	 * these are the controls E7.10 and E7.11 drive.
	 */
	let streamDown = false;
	let tunnelDown = false;
	let tunnelDownOnce = false;
	let streamOpens = 0;
	/*
	 * Every Last-Event-ID the client presented, in arrival order. A Worker that
	 * drops the header leaves nulls here, so "the stream resumed" is falsifiable
	 * rather than assumed.
	 */
	const streamResumes: Array<string | null> = [];
	const rpcCalls: Array<{ method: string; gatewayId: string }> = [];
	/*
	 * What each event poll asked for and what it got back. A client that forgets
	 * its cursor repeats seqs across reads; one that advances past an event it
	 * never read leaves a gap. Both are visible here and in neither case does
	 * the double hide it.
	 */
	const eventCursorReads: Array<{ runId: string; afterSeq: number; returned: number[] }> = [];
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

	/* ---------------------------------------------------------------- */
	/* The platform proxy's upstream. The product Worker validates the    */
	/* browser session, mints the USER's Smithers Cloud token, and        */
	/* forwards these families here with that bearer                      */
	/* (server/src/index.ts PLATFORM_PROXY_RULES). Nothing else opens the */
	/* surface, and every call is recorded with the credential it arrived */
	/* under, so "the browser never saw the bearer" is checkable.         */
	/* ---------------------------------------------------------------- */
	const PLATFORM_PREFIXES = [
		"/api/repos/",
		"/api/github/import",
		"/api/user/github-repos/",
		"/api/user/byok-keys",
		"/api/notifications/",
	];
	const platformCalls: Array<{ method: string; path: string; authorization: string }> = [];

	/*
	 * Which repositories exist in the IMPORTED namespace. Everything under
	 * /api/repos/{o}/{r}/ 404s for a repo that is not there, which is exactly
	 * what drives the seams' import-readiness degradation; will/mvp is
	 * deliberately absent so that path is reachable without a control call.
	 */
	const importedRepos = new Set(["will/flows", "will/smithers"]);

	interface StubNotification {
		id: string;
		subject: { title: string };
		repository: { full_name: string };
		reason: string;
		updated_at: string;
		unread: boolean;
	}
	const freshNotifications = (): StubNotification[] => [
		{
			id: "1",
			subject: { title: "Wire the sync adapter" },
			repository: { full_name: "will/flows" },
			reason: "review_requested",
			updated_at: "2026-08-17T10:00:00.000Z",
			unread: true,
		},
		{
			id: "2",
			subject: { title: "Flaky heartbeat suite" },
			repository: { full_name: "will/smithers" },
			reason: "assign",
			updated_at: "2026-08-16T10:00:00.000Z",
			unread: true,
		},
		{
			id: "3",
			subject: { title: "Docs pass" },
			repository: { full_name: "will/flows" },
			reason: "mention",
			updated_at: "2026-08-15T10:00:00.000Z",
			unread: false,
		},
	];
	let notifications = freshNotifications();

	/* A BYOK row never carries key material: only the mask leaves the store. */
	const freshKeys = (): Array<Record<string, string>> => [
		{ provider: "anthropic", last4: "4242" },
		{ provider: "openai", masked: "sk-…9f21" },
	];
	let byokKeys = freshKeys();

	interface StubImportJob {
		importJobId: string;
		status: "cloning" | "ready" | "failed";
		stage: string | null;
		error: string | null;
	}
	const importJobs = new Map<string, StubImportJob>();
	let importSerial = 1;
	let importConflictOnce = false;
	/* The terminal state the next poll of a running job moves to, if any. */
	let importOutcome: "cloning" | "ready" | "failed" = "cloning";

	let githubAppInstalled = true;

	interface StubIssue {
		number: number;
		title: string;
		state: "open" | "closed";
		author: { login: string };
		comment_count: number;
		updated_at: string;
		body: string;
		labels: Array<{ name: string }>;
	}
	const issuesByRepo = new Map<string, StubIssue[]>();
	const commentsByIssue = new Map<string, Array<{ commenter: string; body: string; created_at: string }>>();
	const issuesFor = (repo: string): StubIssue[] => {
		const existing = issuesByRepo.get(repo);
		if (existing !== undefined) return existing;
		const seeded: StubIssue[] = [
			{
				number: 12,
				title: "Wire the sync adapter",
				state: "open",
				author: { login: "will" },
				comment_count: 1,
				updated_at: "2026-07-28T10:00:00.000Z",
				body: "The adapter never reconnects after a dropped socket.",
				labels: [{ name: "bug" }],
			},
			{
				number: 9,
				title: "Document the harness",
				state: "closed",
				author: { login: "octocat" },
				comment_count: 0,
				updated_at: "2026-07-20T10:00:00.000Z",
				body: "",
				labels: [],
			},
		];
		issuesByRepo.set(repo, seeded);
		commentsByIssue.set(`${repo}#12`, [
			{ commenter: "octocat", body: "Reproduced on main.", created_at: "2026-07-29T10:00:00.000Z" },
		]);
		return seeded;
	};

	interface StubEnvironment {
		setup_script: string;
		env: Array<{ name: string; value: string }>;
		secrets: Array<{ name: string; updated_at: string }>;
	}
	const environments = new Map<string, StubEnvironment>();
	const environmentFor = (repo: string): StubEnvironment => {
		const existing = environments.get(repo);
		if (existing !== undefined) return existing;
		const created: StubEnvironment = {
			setup_script: "bun install\n",
			env: [
				{ name: "LOG_LEVEL", value: "debug" },
				{ name: "NODE_ENV", value: "test" },
			],
			secrets: [{ name: "ANTHROPIC_API_KEY", updated_at: "2026-08-01T10:00:00.000Z" }],
		};
		environments.set(repo, created);
		return created;
	};

	/*
	 * Two pages with a real cursor. `main` sits on the SECOND page, so a client
	 * that reads one page and stops loses the base bookmark a landing needs —
	 * the exact failure fetchAllBookmarks paginates to avoid.
	 */
	const BOOKMARK_PAGES: Record<string, { items: Array<Record<string, unknown>>; next_cursor: string }> = {
		"": {
			items: [
				{
					name: "landing/sync-adapter",
					target_change_id: "kxpzntslqrmw",
					target_commit_id: "a1b2c3d4e5f6",
					is_tracking_remote: false,
				},
			],
			next_cursor: "page-2",
		},
		"page-2": {
			items: [
				{
					name: "main",
					target_change_id: "qqrsuvwzyxtn",
					target_commit_id: "b2c3d4e5f6a7",
					is_tracking_remote: true,
				},
			],
			next_cursor: "",
		},
	};

	/* One tiny tree, base64 exactly like the platform answers file contents. */
	const REPO_FILES: Record<string, string> = {
		"README.md": "# flows\n\nThe harness.\n",
		"src/index.ts": "export const start = () => undefined;\n",
	};
	const REPO_DIRS: Record<string, Array<{ name: string; path: string; type: "file" | "dir" }>> = {
		"": [
			{ name: "README.md", path: "README.md", type: "file" },
			{ name: "src", path: "src", type: "dir" },
		],
		src: [{ name: "index.ts", path: "src/index.ts", type: "file" }],
	};

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

	/*
	 * The platform families the Worker proxies. Ordering matters: this runs
	 * AFTER the provision route, because /api/repos/ is a proxy PREFIX and a
	 * naive prefix branch placed first would swallow
	 * POST /api/repos/{o}/{r}/gateway.
	 */
	const handlePlatform = async (request: Request, url: URL): Promise<Response | undefined> => {
		if (!PLATFORM_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return undefined;
		platformCalls.push({
			method: request.method,
			path: url.pathname + url.search,
			authorization: request.headers.get("authorization") ?? "",
		});
		// The user's own Cloud token or nothing: a deployment credential, a
		// browser cookie, and an empty header all fail the same way.
		if (request.headers.get("authorization") !== `Bearer ${STUB_CLOUD_TOKEN}`) {
			return json(401, { error: "unauthorized", message: "the platform needs the user's Smithers Cloud token" });
		}

		/* ---- notifications ---- */
		if (url.pathname === "/api/notifications/list" && request.method === "GET") {
			// A BARE array, the shape parseNotificationListBody reads.
			return json(200, notifications);
		}
		if (url.pathname === "/api/notifications/mark-read" && request.method === "PUT") {
			for (const row of notifications) row.unread = false;
			// 205 with no body, exactly like the platform. A client that only
			// accepts 2xx-with-body treats success as a failure.
			return new Response(null, { status: 205 });
		}

		/* ---- BYOK keys ---- */
		if (url.pathname === "/api/user/byok-keys" && request.method === "GET") {
			return json(200, { keys: byokKeys });
		}
		if (url.pathname === "/api/user/byok-keys" && request.method === "POST") {
			const body = (await request.json().catch(() => null)) as { provider?: unknown; key?: unknown } | null;
			const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
			const key = typeof body?.key === "string" ? body.key : "";
			if (provider === "" || key === "") {
				return json(400, { error: "provider and key are required" });
			}
			// The stored row carries a mask, never the key: the secret law holds
			// on the write path too.
			byokKeys = [...byokKeys.filter((row) => row.provider !== provider), { provider, last4: key.slice(-4) }];
			return json(201, { provider, masked: `sk-…${key.slice(-4)}` });
		}
		const keyDelete = /^\/api\/user\/byok-keys\/([^/]+)$/.exec(url.pathname);
		if (keyDelete !== null && request.method === "DELETE") {
			const provider = decodeURIComponent(keyDelete[1] ?? "");
			const before = byokKeys.length;
			byokKeys = byokKeys.filter((row) => row.provider !== provider);
			// Deleting a provider that is not configured is a 404, so a second
			// removal cannot be reported to the user as a success.
			if (byokKeys.length === before) return json(404, { error: "not_found", message: `no ${provider} key` });
			return new Response(null, { status: 204 });
		}

		/* ---- GitHub import ---- */
		if (url.pathname === "/api/github/import" && request.method === "POST") {
			if (importConflictOnce) {
				importConflictOnce = false;
				return json(409, { error: "conflict", message: "repository already exists" });
			}
			const body = (await request.json().catch(() => null)) as { owner?: unknown; repo?: unknown } | null;
			// The client sends {owner, repo}; anything else is a 400, so a
			// change to that body shape cannot pass unnoticed.
			if (typeof body?.owner !== "string" || body.owner === "" || typeof body.repo !== "string" || body.repo === "") {
				return json(400, { error: "owner and repo are required" });
			}
			const importJobId = `job-${importSerial++}`;
			importJobs.set(importJobId, { importJobId, status: "cloning", stage: "cloning_github", error: null });
			return json(200, importJobs.get(importJobId));
		}
		const importPoll = /^\/api\/github\/import\/([^/]+)$/.exec(url.pathname);
		if (importPoll !== null && request.method === "GET") {
			const job = importJobs.get(decodeURIComponent(importPoll[1] ?? ""));
			// An unknown job id is a 404: a client that fabricates or mangles the
			// id it was handed cannot appear to be tracking a real import.
			if (job === undefined) return json(404, { error: "not_found", message: "no such import job" });
			if (job.status === "cloning" && importOutcome !== "cloning") {
				job.status = importOutcome;
				job.stage = importOutcome === "ready" ? null : job.stage;
				job.error = importOutcome === "failed" ? "the mirror push was rejected" : null;
			}
			return json(200, job);
		}

		/* ---- source-only issues (the import-readiness fallback) ---- */
		const sourceIssues = /^\/api\/user\/github-repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
		if (sourceIssues !== null && request.method === "GET") {
			const state = url.searchParams.get("state") ?? "all";
			const repo = `${sourceIssues[1]}/${sourceIssues[2]}`;
			const rows = issuesFor(repo)
				.filter((issue) => state === "all" || issue.state === state)
				.map((issue) => ({
					number: issue.number,
					title: issue.title,
					state: issue.state,
					user: { login: issue.author.login },
					comments: issue.comment_count,
					updated_at: issue.updated_at,
				}));
			// GitHub's issues endpoint includes pull requests. The row stays in
			// the answer so a client that fails to drop it counts one too many.
			return json(200, [
				...rows,
				{
					number: 40,
					title: "Wire the sync adapter",
					state: "open",
					user: { login: "will" },
					comments: 0,
					updated_at: "2026-07-28T10:00:00.000Z",
					pull_request: { url: `https://api.github.com/repos/${repo}/pulls/40` },
				},
			]);
		}

		/* ---- the imported namespace ---- */
		const scoped = /^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(url.pathname);
		if (scoped === null) return json(404, { error: "not_found", message: `platform stub: no route ${url.pathname}` });
		const repo = `${scoped[1]}/${scoped[2]}`;
		const rest = scoped[3] ?? "";
		if (!importedRepos.has(repo)) {
			// The whole namespace 404s for a repo Smithers Cloud never imported.
			return json(404, { error: "not_found", message: "repository not found" });
		}

		if (rest === "/bookmarks" && request.method === "GET") {
			const cursor = url.searchParams.get("cursor") ?? "";
			const page = BOOKMARK_PAGES[cursor];
			if (page === undefined) return json(400, { error: "bad_cursor", message: `unknown cursor ${cursor}` });
			return json(200, page);
		}

		if (rest === "/github-app-status" && request.method === "GET") {
			return json(200, {
				github_app_installed: githubAppInstalled,
				github_app_configured: true,
				install_url: "https://github.com/apps/smithers/installations/new",
			});
		}

		if (rest === "/agent-environment" && request.method === "GET") {
			return json(200, environmentFor(repo));
		}
		if (rest === "/agent-environment" && request.method === "PUT") {
			const body = (await request.json().catch(() => null)) as
				| { setup_script?: unknown; env?: unknown; secrets?: unknown }
				| null;
			if (body !== null && "secrets" in body) {
				// Secrets are write-only upstream; a document that carries them
				// back is a client that read a value it must never have.
				return json(400, { error: "secrets are write-only and cannot be sent back" });
			}
			if (typeof body?.setup_script !== "string" || !Array.isArray(body.env)) {
				return json(400, { error: "setup_script and env are required" });
			}
			const env: Array<{ name: string; value: string }> = [];
			for (const entry of body.env) {
				const pair = entry as { name?: unknown; value?: unknown } | null;
				if (pair === null || typeof pair !== "object") return json(400, { error: "env rows must be objects" });
				if (typeof pair.name !== "string" || pair.name === "" || typeof pair.value !== "string") {
					return json(400, { error: "env rows need a name and a value" });
				}
				env.push({ name: pair.name, value: pair.value });
			}
			/*
			 * The whole document replaces the stored one. A client that PUTs
			 * only the pair it changed drops every other variable, and the next
			 * GET states the loss instead of hiding it.
			 */
			const stored = environmentFor(repo);
			environments.set(repo, { setup_script: body.setup_script, env, secrets: stored.secrets });
			return json(200, { status: "ok" });
		}

		const contents = /^\/contents(?:\/(.*))?$/.exec(rest);
		if (contents !== null && request.method === "GET") {
			const path = decodeURIComponent(contents[1] ?? "")
				.split("/")
				.filter(Boolean)
				.join("/");
			const dir = REPO_DIRS[path];
			if (dir !== undefined) return json(200, dir);
			const file = REPO_FILES[path];
			if (file !== undefined) {
				return json(200, { path, content: btoa(file), encoding: "base64", size: file.length });
			}
			// A missing PATH inside an imported repo names the path; a missing
			// REPO 404s the namespace above. FilesSeam splits on exactly that.
			return json(404, { error: "not_found", message: `Path not found: ${path}` });
		}

		const issueComments = /^\/issues\/(\d+)\/comments$/.exec(rest);
		if (issueComments !== null) {
			const number = Number(issueComments[1]);
			if (!issuesFor(repo).some((issue) => issue.number === number)) {
				return json(404, { error: "not_found", message: `no issue #${number}` });
			}
			const key = `${repo}#${number}`;
			if (request.method === "GET") return json(200, commentsByIssue.get(key) ?? []);
			if (request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { body?: unknown } | null;
				if (typeof body?.body !== "string" || body.body === "") return json(400, { error: "body is required" });
				const comment = { commenter: "will", body: body.body, created_at: new Date().toISOString() };
				commentsByIssue.set(key, [...(commentsByIssue.get(key) ?? []), comment]);
				const issue = issuesFor(repo).find((row) => row.number === number);
				if (issue !== undefined) issue.comment_count += 1;
				return json(201, comment);
			}
		}

		const issueDetail = /^\/issues\/(\d+)$/.exec(rest);
		if (issueDetail !== null) {
			const number = Number(issueDetail[1]);
			const issue = issuesFor(repo).find((row) => row.number === number);
			if (issue === undefined) return json(404, { error: "not_found", message: `no issue #${number}` });
			if (request.method === "GET") return json(200, issue);
			if (request.method === "PATCH") {
				const body = (await request.json().catch(() => null)) as { state?: unknown } | null;
				if (body?.state !== "open" && body?.state !== "closed") {
					return json(400, { error: "state must be open or closed" });
				}
				issue.state = body.state;
				issue.updated_at = new Date().toISOString();
				return json(200, issue);
			}
		}

		if (rest === "/issues" && request.method === "GET") {
			const state = url.searchParams.get("state");
			// Plue 422s an unknown state, "all" included. The client is supposed
			// to OMIT the parameter to list every state; forwarding state=all is
			// a real defect and this is where it surfaces.
			if (state !== null && state !== "open" && state !== "closed") {
				return json(422, { error: "unprocessable", message: `unsupported state ${state}` });
			}
			return json(
				200,
				issuesFor(repo).filter((issue) => state === null || issue.state === state),
			);
		}
		if (rest === "/issues" && request.method === "POST") {
			const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
			if (typeof body?.title !== "string" || body.title.trim() === "") {
				return json(400, { error: "title is required" });
			}
			const rows = issuesFor(repo);
			const created: StubIssue = {
				number: Math.max(0, ...rows.map((issue) => issue.number)) + 1,
				title: body.title,
				state: "open",
				author: { login: "will" },
				comment_count: 0,
				updated_at: new Date().toISOString(),
				body: "",
				labels: [],
			};
			rows.push(created);
			return json(201, created);
		}

		return json(404, { error: "not_found", message: `platform stub: no route ${request.method} ${url.pathname}` });
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
			/* E7.10 / E7.11: the SSE seam and the relay tunnel, failable on demand. */
			if (url.pathname === "/stub/stream-down" && request.method === "POST") {
				streamDown = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/stream-up" && request.method === "POST") {
				streamDown = false;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/tunnel-down" && request.method === "POST") {
				tunnelDown = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/tunnel-down-once" && request.method === "POST") {
				tunnelDownOnce = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/tunnel-up" && request.method === "POST") {
				tunnelDown = false;
				tunnelDownOnce = false;
				streamDown = false;
				return json(200, { status: "ok" });
			}
			/*
			 * Append one event to a live run. A suite drops the stream, emits
			 * here, and restores: the client's next poll must return exactly this
			 * seq, exactly once. A reconnect that lost the cursor shows up as a
			 * gap or a repeat in eventCursorReads instead of passing silently.
			 */
			if (url.pathname === "/stub/emit-event" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as
					| { runId?: unknown; event?: unknown; payload?: unknown }
					| null;
				const run = runs.get(typeof body?.runId === "string" ? body.runId : "");
				if (run === undefined) return json(404, { status: "error", message: "no such run" });
				const event = typeof body?.event === "string" && body.event !== "" ? body.event : "NodeFinished";
				emit(run, event, body?.payload ?? {});
				return json(200, { status: "ok", seq: run.events.length });
			}
			/* Platform-proxy controls. */
			if (url.pathname === "/stub/import-ready" && request.method === "POST") {
				importOutcome = "ready";
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/import-failed" && request.method === "POST") {
				importOutcome = "failed";
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/import-conflict" && request.method === "POST") {
				importConflictOnce = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/app-uninstalled" && request.method === "POST") {
				githubAppInstalled = false;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/app-installed" && request.method === "POST") {
				githubAppInstalled = true;
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/unimport-repo" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { repo?: unknown } | null;
				if (typeof body?.repo !== "string") return json(400, { error: "repo is required" });
				importedRepos.delete(body.repo);
				return json(200, { status: "ok", imported: [...importedRepos] });
			}
			if (url.pathname === "/stub/import-repo" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { repo?: unknown } | null;
				if (typeof body?.repo !== "string") return json(400, { error: "repo is required" });
				importedRepos.add(body.repo);
				return json(200, { status: "ok", imported: [...importedRepos] });
			}
			if (url.pathname === "/stub/platform-calls" && request.method === "GET") {
				return json(200, { calls: platformCalls });
			}
			// Return the double to its boot state so the next suite starts clean.
			if (url.pathname === "/stub/reset" && request.method === "POST") {
				failNext = false;
				provisions = 0;
				capacity = true;
				provisioningOnce = false;
				cloudRepo = true;
				stalled = false;
				eventReads = 0;
				streamDown = false;
				tunnelDown = false;
				tunnelDownOnce = false;
				streamOpens = 0;
				streamResumes.length = 0;
				rpcCalls.length = 0;
				eventCursorReads.length = 0;
				platformCalls.length = 0;
				lastApproval = undefined;
				runs.clear();
				gateways.clear();
				notifications = freshNotifications();
				byokKeys = freshKeys();
				importJobs.clear();
				importConflictOnce = false;
				importOutcome = "cloning";
				githubAppInstalled = true;
				issuesByRepo.clear();
				commentsByIssue.clear();
				environments.clear();
				importedRepos.clear();
				for (const repo of ["will/flows", "will/smithers"]) importedRepos.add(repo);
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/relay-state" && request.method === "GET") {
				return json(200, {
					provisions,
					eventReads,
					streamOpens,
					streamResumes: [...streamResumes],
					rpcCalls: [...rpcCalls],
					eventCursorReads: eventCursorReads.map((read) => ({ ...read, returned: [...read.returned] })),
					platformCalls: [...platformCalls],
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
				/*
				 * A Cloudflare tunnel failure sits in FRONT of the gateway, so it
				 * lands before auth. Provisioning stays healthy while it is down,
				 * which is the shape the gateway seam re-provisions out of.
				 */
				if (tunnelDown || tunnelDownOnce) {
					tunnelDownOnce = false;
					return new Response("error code: 502\n", { status: 502, headers: { "content-type": "text/plain" } });
				}
				const entry = gateways.get(relay[1] ?? "");
				if (entry === undefined || request.headers.get("authorization") !== `Bearer ${entry.token}`) {
					return json(401, { message: "invalid gateway credentials" });
				}
				const path = relay[2] ?? "";
				const rpcMethod = /^\/v1\/rpc\/(.+)$/.exec(path)?.[1];
				if (rpcMethod !== undefined && request.method === "POST") {
					const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
					rpcCalls.push({ method: rpcMethod, gatewayId: relay[1] ?? "" });
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
					const runId = decodeURIComponent(events[1] ?? "");
					const run = runs.get(runId);
					// Wave 12 §3: the count a caller reads back to prove the client's
					// pump actually STOPPED, rather than merely repainting the card.
					eventReads += 1;
					const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
					const rows = (run?.events ?? []).filter((row) => row.seq > afterSeq);
					eventCursorReads.push({ runId, afterSeq, returned: rows.map((row) => row.seq) });
					return json(200, { ok: true, data: rows });
				}
				if (path === "/v1/api/stream" && request.method === "GET") {
					if (streamDown) {
						return new Response("error code: 502\n", { status: 502, headers: { "content-type": "text/plain" } });
					}
					/*
					 * The change stream, with the monotonic ids Last-Event-ID
					 * resumes from: each reconnect continues from the id the
					 * previous frame carried. `retry: 500` makes a browser
					 * reconnect twice a second instead of every three.
					 */
					const resume = request.headers.get("last-event-id");
					streamResumes.push(resume);
					streamOpens += 1;
					const parsed = Number(resume ?? "0");
					const next = Number.isFinite(parsed) ? parsed + 1 : 1;
					return new Response(
						`retry: 500\nid: ${next}\nevent: change\ndata: {"seq":${next},"collections":["run_events"]}\n\n`,
						{
							status: 200,
							headers: {
								"content-type": "text/event-stream; charset=utf-8",
								"x-accel-buffering": "no",
							},
						},
					);
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
			const platform = await handlePlatform(request, url);
			if (platform !== undefined) return platform;
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
 *
 * It also models the 7-day dismissal window, DEFAULT OFF: worker-e2e dismisses
 * a recommendation mid-run and then reads first-run again for the watched-set
 * mirror, so arming it unconditionally would change what that suite sees.
 */
export const createStubReco = (extraAllowedOrigins: ReadonlyArray<string> = []): StubHandle => {
	let degraded = false;
	let personaLogin = "will";
	const feedbackLog: Array<{ at: string; action: string; recommendationId: string; evidenceKey: string | null }> =
		[];
	/*
	 * The dismissal window the real reco worker enforces. A dismissed
	 * recommendation is withheld until the window passes; past it, it returns
	 * carrying what changed, so "it came back" and "it never left" are
	 * different observable answers. Checklist CN-17 tracks the real
	 * DELETE /api/reco/admin/dismissals door, which does not exist yet.
	 */
	const SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000;
	const dismissedAt = new Map<string, number>();
	const watchedWrites: Array<{ at: string; selected: string[]; via: string }> = [];
	let suppressDismissed = false;
	/* Test clock skew, so a suite can cross the window without waiting a week. */
	let clockSkewMs = 0;
	const stubNow = (): number => Date.now() + clockSkewMs;

	/*
	 * Wave 10 — the watched-repos contract: the stub honors the landed
	 * wave-10b routes. `selected: null` = never chosen (needsSelection, with
	 * the candidates inline); [] = deliberately chose none (emptySelection);
	 * a chosen set scopes the digest to exactly those repos.
	 */
	let watched: { selected: string[]; selectedAt: string; via: string } | null = null;
	interface StubRecoCandidate {
		fullName: string;
		private: boolean;
		pushedAt: string | null;
		openIssues: number;
	}
	const defaultCandidates = (): Array<StubRecoCandidate> => [
		{ fullName: "will/flows", private: false, pushedAt: "2026-08-07T12:00:00.000Z", openIssues: 4 },
		{ fullName: "will/smithers", private: false, pushedAt: "2026-08-06T09:00:00.000Z", openIssues: 2 },
		{ fullName: "will/mvp", private: true, pushedAt: "2026-08-05T18:00:00.000Z", openIssues: 1 },
	];
	let candidates: Array<StubRecoCandidate> = defaultCandidates();

	const grounded = (repos: ReadonlyArray<string>) => {
		const considered = repos.length;
		const primary = repos[0] ?? "will/flows";
		const id = `review-pr:${primary}#12`;
		const dismissed = suppressDismissed ? dismissedAt.get(id) : undefined;
		const suppressed = dismissed !== undefined && stubNow() - dismissed < SUPPRESSION_MS;
		// Past the window it returns, and it says what changed while it was set
		// aside. A card that comes back unchanged is the defect this catches.
		const returning = dismissed !== undefined && !suppressed;
		return {
			degraded: false,
			cached: false,
			watched: [...repos],
			digest: {
				login: personaLogin,
				computedAt: "2026-08-08T09:00:00.000Z",
				reposConsidered: considered,
				openIssues: considered * 2,
				openPullRequests: considered > 1 ? 2 : 0,
				staleCount: considered,
				mostActiveRepo: { name: primary, pushedAt: "2026-08-07T12:00:00.000Z" },
				oldestWaiting: {
					kind: "pr",
					repo: primary,
					number: 12,
					title: "Wire the sync adapter",
					url: `https://github.com/${primary}/pull/12`,
					updatedAt: "2026-07-28T10:00:00.000Z",
					waitingDays: 11,
				},
				untriagedInMostActive: considered,
				sentence: `You have ${considered * 2} open issues across ${considered} repo${
					considered === 1 ? "" : "s"
				}; the oldest has waited 11 days.`,
			},
			recommendation: suppressed
				? null
				: {
					id,
					...(returning
						? { whatChanged: "the pull request picked up 2 new commits since you set it aside" }
						: {}),
					type: "review-pr",
					rank: 1,
					title: `Review "Wire the sync adapter" in ${primary}`,
					proposes: `Open pull request #12 ("Wire the sync adapter") in ${primary} for review.`,
					whyNow: "It is the oldest pull request waiting on you — untouched for 11 days.",
					whatHappens:
						"Smithers opens the diff for this pull request and walks it with you; nothing is merged or closed until you say so.",
					subject: {
						kind: "pr",
						repo: primary,
						number: 12,
						title: "Wire the sync adapter",
						url: `https://github.com/${primary}/pull/12`,
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
				}
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
			if (url.pathname === "/stub/persona" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as {
					login?: unknown;
					candidates?: unknown;
					watched?: unknown;
					dismissals?: unknown;
				} | null;
				const parsedCandidates = Array.isArray(body?.candidates)
					? body.candidates.filter(
							(candidate): candidate is StubRecoCandidate =>
								typeof candidate === "object" &&
								candidate !== null &&
								typeof (candidate as { fullName?: unknown }).fullName === "string" &&
								typeof (candidate as { private?: unknown }).private === "boolean" &&
								((candidate as { pushedAt?: unknown }).pushedAt === null ||
									typeof (candidate as { pushedAt?: unknown }).pushedAt === "string") &&
								typeof (candidate as { openIssues?: unknown }).openIssues === "number",
						)
					: [];
				const watchedValid =
					body?.watched === null ||
					(Array.isArray(body?.watched) && body.watched.every((name) => typeof name === "string"));
				const dismissalsValid =
					Array.isArray(body?.dismissals) && body.dismissals.every((id) => typeof id === "string");
				if (
					typeof body?.login !== "string" ||
					parsedCandidates.length !== (Array.isArray(body.candidates) ? body.candidates.length : -1) ||
					!watchedValid ||
					!dismissalsValid
				) {
					return json(400, { status: "error", message: "valid recommendation persona state is required" });
				}
				const selected = body.watched as ReadonlyArray<string> | null;
				const unknown = (selected ?? []).filter(
					(name) => !parsedCandidates.some((candidate) => candidate.fullName === name),
				);
				if (unknown.length > 0) return json(400, { status: "error", message: "unknown watched repositories", unknown });
				personaLogin = body.login;
				candidates = parsedCandidates;
				watched =
					selected === null
						? null
						: { selected: [...selected], selectedAt: new Date().toISOString(), via: "onboarding" };
				dismissedAt.clear();
				for (const id of body.dismissals as ReadonlyArray<string>) dismissedAt.set(id, stubNow());
				return json(200, {
					status: "ok",
					login: personaLogin,
					candidates: candidates.length,
					watched: watched?.selected ?? null,
				});
			}
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
			if (url.pathname === "/stub/dismissal-suppression" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
				suppressDismissed = body?.enabled === true;
				return json(200, { status: "ok", suppressDismissed });
			}
			// Move the double's clock forward, so a suite can cross the 7-day
			// window without waiting for it.
			if (url.pathname === "/stub/advance-days" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { days?: unknown } | null;
				const days = typeof body?.days === "number" && Number.isFinite(body.days) ? body.days : 0;
				clockSkewMs += days * 86_400_000;
				return json(200, { status: "ok", clockSkewMs });
			}
			if (url.pathname === "/stub/clear-dismissals" && request.method === "POST") {
				dismissedAt.clear();
				return json(200, { status: "ok" });
			}
			if (url.pathname === "/stub/dismissals" && request.method === "GET") {
				return json(200, { dismissed: [...dismissedAt].map(([id, at]) => ({ id, at })) });
			}
			if (url.pathname === "/stub/watched-writes" && request.method === "GET") {
				return json(200, { writes: watchedWrites });
			}
			// Return the double to its boot state so the next suite starts clean.
			if (url.pathname === "/stub/reset" && request.method === "POST") {
				degraded = false;
				feedbackLog.length = 0;
				dismissedAt.clear();
				watchedWrites.length = 0;
				suppressDismissed = false;
				clockSkewMs = 0;
				watched = null;
				personaLogin = "will";
				candidates = defaultCandidates();
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
				// Every accepted write, so a suite can prove a trigger wrote once
				// and only once rather than inferring it from the final state.
				watchedWrites.push({ at: watched.selectedAt, selected: [...watched.selected], via });
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
				if (body.action === "dismiss") dismissedAt.set(body.recommendationId, stubNow());
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
	// The platform proxy forwards its allowlisted families here too.
	console.log(`  --var SMITHERS_CLOUD_API_BASE_URL:http://127.0.0.1:${gateway.port}`);
	console.log(`  --var IDENTITY_SERVICE_TOKEN:stub-service-token`);
	console.log(`  --var GATEWAY_SESSION_USER_ID:will`);
	console.log(`  --var RECO_UPSTREAM_URL:http://127.0.0.1:${reco.port}`);
	console.log(`  --var IDENTITY_ADMIN_TOKEN:${STUB_ADMIN_TOKEN}`);
	console.log(`  --var BILLING_ADMIN_TOKEN:${STUB_ADMIN_TOKEN}`);
	console.log(`  --var RECO_ADMIN_TOKEN:${STUB_ADMIN_TOKEN}`);
}
