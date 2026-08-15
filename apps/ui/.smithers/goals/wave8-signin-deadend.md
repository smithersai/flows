# Wave 8 — No dead ends on the live surface

You are working in `/Users/williamcory/mvp` on branch `oneshot-mskp7qe7-work`. House rules per AGENTS.md and all prior receipts; path-scoped commits; keep `bun test src`, typecheck, and `bun scripts/worker-e2e.ts` green. The product is DEPLOYED at https://canary.smithers.sh (worker `smithers-mvp-web`, see `WAVE7-DEPLOY-RECEIPT.md`) — after local proofs pass you ARE authorized to `bun run build && bun x wrangler deploy` from this repo and re-verify against the live URL.

Found by real-browser testing of the deployed product (2026-08-09):

## 1. Sign-in click dead-ends on raw JSON (the bug)
Clicking "Sign in with GitHub" full-page-navigates to `/api/auth/github/start`; while OAuth is unconfigured upstream answers `503 {"code":"oauth_not_configured"}` and the browser renders **raw JSON** — a dead end, forbidden by the design laws (an error must say what the user was doing + the next step, in a human page).
Fix at the seam so it covers every future auth error, not just this one: when the product Worker's `/api/auth/github/start` proxy receives a non-redirect upstream response (503/5xx/4xx), render a minimal, self-contained, branded HTML page (inline CSS, tokens matching the app's paper/teal/gold, no external assets) that says honestly what happened ("GitHub sign-in isn't switched on yet for this preview") and offers one action: a link back to `/`. Keep the machine-readable JSON for callers that send `Accept: application/json`. Same treatment for `/api/auth/github/callback` upstream errors (a failed callback must never strand a user on JSON).
Tests: unit test the seam's HTML-vs-JSON negotiation + both routes; extend the worker e2e (stub identity answering 503) asserting a human page with the return-home link and correct status code.

## 2. Console noise on the signed-out landing
The landing boot fires session/scope probes that log two `Failed to load resource: 401` console errors. A 401 on `/api/auth/session` is the EXPECTED signed-out state, not an error. Where the client initiates these fetches, treat 401 as a normal resolved state (no thrown/logged error path); do not suppress real failures (5xx/network still surface). Verify with a headless run against the local worker: zero console errors on a clean signed-out landing.

## 3. Live re-verification (after deploy)
Headless Playwright (drive via `bun x playwright` from `/Users/williamcory/flows/ui` node_modules or a tiny script) against https://canary.smithers.sh: (a) landing renders the one-sentence + sign-in state with **zero console errors**; (b) clicking sign-in lands on the branded honest page with the way back home, HTTP status preserved; (c) `Accept: application/json` curl still gets the JSON. Screenshot both states into `reports/live-checks/<timestamp>/` (commit).

## 4. Receipt
`WAVE8-RECEIPT.md`: what changed, proofs (local + live, with the screenshots), deployed version id, honest gaps. Small wave — keep it tight.
