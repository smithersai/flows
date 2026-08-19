/**
 * Route contract shared by the browser agent client and the server boundary, so the two
 * can never drift. Kept free of Node imports because the browser bundle imports it.
 */
export const TURN_PATH = "/api/agent/turn";
export const CANCEL_PATH = "/api/agent/turn/cancel";

/*
 * The product Worker's backend seams (Wave 2a): auth/identity proxy routes, the
 * billing proxy routes, and the approval decision round trip. The identity and
 * billing prefixes are proxied wholesale; the approval path is implemented on
 * the Worker itself (it forwards to the gateway's submitApproval RPC).
 */
export const AUTH_ROUTE_PREFIX = "/api/auth/";
export const IDENTITY_ROUTE_PREFIX = "/api/identity/";
export const BILLING_ROUTE_PREFIX = "/api/billing/";
export const AUTH_SCOPES_PATH = "/api/auth/scopes";
export const AUTH_SESSION_PATH = "/api/auth/session";
export const AUTH_SIGN_IN_PATH = "/api/auth/github/start";
/* The native sign-in handoff (device-flow style): OAuth in the system browser. */
export const AUTH_NATIVE_START_PATH = "/api/auth/native/start";
export const AUTH_NATIVE_CLAIM_PATH = "/api/auth/native/claim";
export const AUTH_CALLBACK_PATH = "/api/auth/github/callback";
export const AUTH_LOGOUT_PATH = "/api/auth/logout";
export const IDENTITY_REQUEST_ACCESS_PATH = "/api/identity/request-access";
export const BILLING_BALANCE_PATH = "/api/billing/balance";
export const BILLING_USAGE_PATH = "/api/billing/usage";
export const APPROVAL_DECISION_PATH = "/api/approvals/decision";

/*
 * The recommendations seam (Wave 3b): the product Worker proxies /api/reco/*
 * to RECO_UPSTREAM_URL (the reco worker validates the forwarded session cookie
 * against identity itself). The admin surface is non-enumerable: every
 * /api/admin/* route answers the canonical unknown-route 404 to any session
 * that does not validate as admin:true.
 */
export const RECO_ROUTE_PREFIX = "/api/reco/";
export const RECO_FIRST_RUN_PATH = "/api/reco/first-run";
export const RECO_FEEDBACK_PATH = "/api/reco/feedback";
/*
 * Wave 10 — the watched-repos contract (the reco worker's landed wave-10b):
 * the chooser's candidates, and the user's selection (null = never chosen,
 * a real distinct state — NOT "all repos"; [] = deliberately chose none).
 */
export const RECO_REPOS_PATH = "/api/reco/repos";
export const RECO_WATCHED_PATH = "/api/reco/watched";
/*
 * The browser tool's server-side fetch (Wave 10, §2d): implemented ON the
 * product Worker (SSRF-guarded, no credentials), not proxied to a sibling.
 */
export const TOOLS_BROWSER_FETCH_PATH = "/api/tools/browser-fetch";
/*
 * Wave 11 — the per-user workflow seam (implemented ON the product Worker):
 * provision-or-resume the caller's workspace gateway, relay whitelisted RPCs,
 * read per-run events with afterSeq resume, and proxy the relay SSE change
 * stream. Gateway tokens never reach the browser.
 */
export const WORKFLOW_PROVISION_PATH = "/api/workflow/provision";
export const WORKFLOW_RPC_PATH = "/api/workflow/rpc";
export const WORKFLOW_EVENTS_PATH = "/api/workflow/events";
export const WORKFLOW_STREAM_PATH = "/api/workflow/stream";
/*
 * The chain backend's model relay (DESIGN.md §14, decision D1): the browser
 * runs the real @smthrs/model provider wire against this path; the Worker
 * session-gates the call, injects the provider key, and streams the provider's
 * SSE back verbatim. The full ModelEvent vocabulary therefore reaches the
 * browser without the Worker ever speaking effect — the relay carries the
 * provider protocol, and ModelEvent decoding stays where effect lives.
 */
export const MODEL_STREAM_PATH = "/api/model/stream";

export const ADMIN_ROUTE_PREFIX = "/api/admin/";
export const ADMIN_ALLOWLIST_PATH = "/api/admin/allowlist";
export const ADMIN_GRANT_PATH = "/api/admin/grant";
export const ADMIN_REQUESTS_PATH = "/api/admin/requests";
export const ADMIN_FEEDBACK_PATH = "/api/admin/feedback";
export const ADMIN_HEALTH_PATH = "/api/admin/health";
/** The bounded client-error log: what actually broke in an alpha user's browser. */
export const ADMIN_ERRORS_PATH = "/api/admin/errors";
