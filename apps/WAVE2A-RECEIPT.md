# Wave 2a receipt — Wire the product to its backends: sign-in, money, approvals

Run: `oneshot-wave2a-product-wiring` on branch `oneshot-mskp7qe7-work`, 2026-08-08.

## What landed

### Preflight

The one untracked pre-existing path (`.smithers/goals/wave2a-auth-money-approvals.md`, the goal spec itself) was committed alone as `bb4d898 chore(preflight): preserve pre-existing working-copy changes before oneshot-wave2a-product-wiring`. No conflicts, no `.jjconflict*` trees. Every goal commit contains only goal work; every new file is committed.

### 1. Sign-in + session (`98b199c`, `185e620`, `7364ecf`, `c94bbbf`)

- The product Worker same-origin-proxies `/api/auth/*` and `/api/identity/*` to `IDENTITY_UPSTREAM_URL` — the same seam pattern as the gateway: client `x-user-*` / `authorization` headers are stripped (cookies are forwarded: the identity worker owns its session cookie), honest 501 naming the unset var.
- **Landing state (signed out):** one sentence + one action, *Sign in with GitHub* (`src/mainview/LandingSurface.tsx`). No prompt box, no feature list. The GitHub scopes are stated in plain words *before* redirecting, fetched from `GET /api/auth/scopes`; when the seam can't list them the copy says so honestly.
- **Session:** boot calls `loadSession()` → `GET /api/auth/session` → an `identity.session.loaded` transition (actor `system`) drives the one-row identity record. Only *definitive* answers gate: signed-out → landing; signed-in + not allowlisted → the request-access state; signed-in + allowlisted → chat. `unknown`/`unavailable` never block (dev/native contexts keep working, and a blocked app on a missing backend would be its own dishonesty).
- **Non-allowlisted:** honest sentence + one-click *Request access* → `POST /api/identity/request-access` → confirmation; a failed post sets an honest error line, never a dead end. Sign-out available from the same surface.
- Commands registered and keyboard-complete: `auth.sign-in`, `auth.sign-out`, `auth.request-access` (parity gate updated and green).
- **Local proof:** `scripts/stub-backends.ts` — a clearly labeled test-double identity upstream honoring the contract routes (scopes, start/callback OAuth redirect pair, session, logout, validate, request-access; `/stub/*` control routes exist only on the stub origin). Runnable standalone for `wrangler dev`; driven by the worker e2e.

### 2. Money surfaces (`185e620`, `7364ecf`, `c94bbbf`)

- `/api/billing/*` proxies to `BILLING_UPSTREAM_URL`. Before forwarding, the Worker validates the session cookie against the identity worker's `POST /api/identity/validate` (service-token call) and attaches the two credentials billing actually reads — the `BILLING_AUTH_TOKEN` account bearer and this Worker's own origin — with the validated login riding along as `x-user-*` context. A client-supplied bearer is stripped like every other identity header. No validated session → honest 401; no upstream or no bearer → honest 501.
- **Balance in dollars, persistent and unobtrusive:** the corner-chrome chip shows `$<totalUsd>` (nothing while unknown, "Balance unavailable" on seam failure) and runs `billing.balance`, which refreshes and upserts the balance card into the transcript.
- **First-run line, stated once, plainly:** the balance card reads *"You have $500 of usage on us."* while `chargeCount === 0` (derived from the real balance read — the moment anything is charged, the line is gone). **No card form anywhere** — asserted in the render test.
- **Per-turn cost:** on every settled turn the controller queries `GET /api/billing/usage?run=<turnId>` and records `costUsd` on the completed message ("This turn cost $0.05375.") — words + dollars, never a score; absent (not fake) when the seam has no receipt.
- **Drain-to-$0:** a definitive `allowedToStartWork:false` pauses the composer with an honest one-line state and disables suggestions; history, world docs, and cards stay fully rendered. A turn attempt at $0 dispatches `billing.work.paused` — a calm one-line Smithers message, phase stays idle, the draft is not eaten, the agent never runs (proven: `turns === 0`).

### 3. Approval round trip (`98b199c`, `185e620`, `7364ecf`, `c94bbbf`)

- `POST /api/approvals/decision` on the Worker validates `{runId, nodeId, iteration, decision:{approved, note?}}` and forwards to the gateway upstream's `POST /v1/rpc/submitApproval` with the seam's identity injection (service token or validated-session placeholder headers). Honest 501 when no upstream; upstream statuses (e.g. 409 AlreadyDecided) pass through verbatim.
- Client flow: ApprovalCard decision → `approval.approve`/`approval.deny` command → `card.approval.decision.pending` → POST → on success `card.approval.decided` **from the server echo** (`echo.approved` drives the recorded decision); on failure `card.approval.decision.failed` → status `error` with the honest message, actions still rendered, retry works (proven: fail-then-succeed test). Pending state hides the actions with "Sending your decision…". A card without `{runId, nodeId, iteration}` cannot be fake-decided — it gets an honest "not linked to a run" error.
- `src/shared/Cards.ts` extended compatibly: approval payload gains optional `runId`, `nodeId`, `iteration`, `pending`, `error`; Wave-1 cards still parse.
- **Test-double gateway:** unit tests (Worker forwards with injected identity, echo returned, failure passthrough) + the worker e2e asserts the full loop including the injected `x-user-id` reaching the double, plus the deny and forced-failure paths.

### 4. Stop discipline (`7364ecf`, `c94bbbf`)

- Escape (typing) → `chat.stop` command (canonical; `stop` kept as hidden alias) → `cancelTurn` (POST `/api/agent/turn/cancel`) + synchronous `message.response.cancelled` with `detail: "Stopped the current response."` — partial text kept, interrupted marker + the one-line statement, composer back to idle immediately.
- A stream that ends without a `done` frame (upstream disconnect mid-stream) now publishes `done` with an error — an honest failed turn, never a silent stall (`WebAgent.ts`; controller test proves the failed state and idle phase).

## Proofs (all run this wave, observed output)

- `bun test src` → `85 pass / 0 fail, 281 expect() calls, 10 files` (was 52/169).
- `bun run typecheck` → clean (no output, exit 0).
- `bun scripts/worker-e2e.ts` →
  `ok: SPA served with COOP/COEP headers.` /
  `ok: one streamed chat turn completed through /api/agent/turn (delta → card → done).` /
  `ok: cancel endpoint answered.` /
  `ok: gateway seam 501s honestly with no upstream configured.` /
  `ok: identity seam 501s honestly with no upstream configured.` /
  `ok: billing seam 501s honestly with no upstream configured.` /
  `ok: approvals route 501s honestly with no gateway configured.` /
  `ok: cross-origin requests to the API are refused (403) before any credential is spent.` /
  `ok: auth journey through the stub identity upstream (signed-out → sign-in → non-allowlisted → request-access → allowlisted → chat).` /
  `ok: balance reads in dollars and drains to $0 with allowedToStartWork:false (stub billing, which — like the real worker — answers only an allowed origin carrying the Smithers Cloud user bearer).` /
  `ok: approval round trip through the gateway double — approve echo, deny echo, injected identity, honest failure.` /
  `PASS: worker e2e — build, wrangler dev, streamed turn, seam discipline, auth journey, $0 pause, approval round trip.`
- `rg useEffect src` → no matches in application code.

## Contract assumptions about the identity worker (for integration to verify)

The first pass of this wave was written before `flows/ui/workers/identity` existed and assumed the goal doc. A follow-up review read the **landed code** for both siblings (`workers/identity/src/index.ts`, `workers/billing/src/index.ts` + `DEPLOY.md`) and corrected the product to it (see "Review corrections" below). Verified against that code:

1. `GET /api/auth/session` → `200 {login, allowlisted, admin, scopes}` signed in; **`401` signed out** — matches `loadSession`.
2. `GET /api/auth/scopes` → `{provider, requestedScopes, scopes: [{scope, plain, why}]}`, where each `plain` is a **whole sentence**. The client states them after a lead-in ("Before GitHub asks, here is what Smithers will use: …"), never spliced mid-sentence.
3. `GET /api/auth/github/start` is the OAuth entry point; sign-in is a full-page redirect to it. It 503s honestly when the OAuth app credentials aren't installed.
4. `POST /api/auth/logout` clears the session cookie; any 2xx = signed out.
5. `POST /api/identity/request-access` uses the session cookie (`201` first time, `200` on the idempotent repeat — the client treats any 2xx as recorded).
6. `POST /api/identity/validate` takes the forwarded `cookie` plus `x-smithers-service-token: <IDENTITY_SERVICE_TOKEN>` and returns `200 {valid:true, login, allowlisted, admin, scopes}` or `200 {valid:false}`; the product Worker treats a missing `login` as no session.
7. **Origin:** both siblings gate on the browser `Origin` (`ALLOWED_ORIGINS`, localhost always allowed) — and billing **403s a request that carries none**, which is exactly what a same-origin browser GET is. The proxy therefore sets its own origin on every identity- and billing-bound request. **Deployment requirement: this Worker's origin must be listed in both siblings' `ALLOWED_ORIGINS`.**
8. **Billing credential:** billing's `authenticate()` accepts only `Authorization: Bearer <Smithers Cloud user bearer>` (resolved against `SMITHERS_CLOUD_API_BASE_URL/api/user`); it reads no `x-user-*` claim. The Worker attaches `BILLING_AUTH_TOKEN` and 501s honestly when it is unset. The validated login still rides along as `x-user-*` **context only**. Open item for integration: that bearer is currently one deployment-wide account, because the identity worker's vault holds a **GitHub** token, not a Smithers Cloud bearer — per-user billing needs one of the two services to bridge that.

### Review corrections (this pass)

Reading the landed sibling code turned up three things the stubs had hidden, all fixed and covered:

- Billing was proxied with `authorization` **stripped** and `x-user-id` injected — a credential billing does not read. Against the real worker every balance read would have been a 401 while the stub said PASS. Now: deployment bearer injected, honest 501 when unconfigured, stub tightened to demand it.
- Billing was proxied with **no `Origin`**, which the real worker rejects outright with 403. Now the proxy states its own origin; both doubles enforce the gate.
- `POST /api/approvals/decision` spends the seam's injected identity and had **no same-origin guard**; a `text/plain` POST from any site is not preflighted, so a page anywhere could have submitted approval decisions. The API surface now refuses cross-origin requests with 403 before any credential is spent.

## Honest gaps

- **The turn endpoint is not gated server-side.** `/api/agent/turn` does not check identity or balance; gating is client-side (landing states, $0 composer pause). A direct API caller bypasses it. Server-side turn authorization (validate session + check `allowedToStartWork` before streaming) is the follow-up.
- **Approvals inject the gateway seam's configured identity** (`GATEWAY_AUTH_TOKEN` or the `GATEWAY_SESSION_USER_*` placeholder), not the validated identity session — the plumbing exists (`validateSession`) but the gateway seam's session termination is still deployment-configured, as in Wave 1.
- **Per-turn cost only appears when the billing upstream meters by the client's turn runId.** Today chat.smithers.sh meters its own run ids, so the line is honestly absent against the real chat backend until metering keys align.
- The identity and billing integrations are **unproven against the running services** — the product was corrected to their landed source, but nothing has been deployed or curled end to end. All proofs run against the labeled doubles, which now enforce the same origin and credential gates the real workers do.
- **Per-user billing is not solved.** `BILLING_AUTH_TOKEN` is one account for the whole deployment; see contract assumption 8.
- Escape → cancel keeps the Wave-1 caveat: the cancel map is per-isolate best effort; disconnect-driven cancel is the reliable path.
- The Vite dev boundary (`bun run web`) proxies none of the new seams; there the records land as `unavailable` honestly and the app stays usable.
