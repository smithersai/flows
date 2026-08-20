# Wave 2a — Wire the product to its backends: sign-in, money, approvals

You are working in `/Users/williamcory/mvp` on branch `oneshot-mskp7qe7-work`. Read `WAVE1-RECEIPT.md`, `DESIGN.md`, `AGENTS.md` first. House rules hold: **no `useEffect`; components are projections; every mutation through the Flux dispatcher with actor recorded; every new affordance is a registered command (the parity gate will fail you otherwise); honest states over fake success — if a backend isn't configured, the UI says so plainly.** Keep `bun test src` green and `bun run typecheck` clean throughout; extend the worker e2e (`bun scripts/worker-e2e.ts`) for what you add.

Wave-1 substrate you build on: card frames flow server→store→render; the Worker server (`src/worker/index.ts`) has the trusted-proxy gateway seam (`GATEWAY_UPSTREAM_URL`, header strip/inject, 501 honest when unset); the command registry is law.

## 1. Sign-in + session (against the identity-worker contract)
A sibling service is being built at `/Users/williamcory/flows/ui/workers/identity` to the contract in `/Users/williamcory/flows/ui/.smithers/goals/wave2-identity-allowlist-worker.md` (read it; if `workers/identity/` already has code and `WAVE2-IDENTITY-RECEIPT.md`, treat the code as the contract). The product Worker same-origin-proxies `/api/auth/*` and `/api/identity/*` to it via an `IDENTITY_UPSTREAM_URL` env (same pattern as the gateway seam: strip client identity headers, honest 501 when unset).

- **Landing state (signed out):** exactly one sentence + one action, *Sign in with GitHub*. No blank prompt box, no feature list. Before redirecting, state the scopes in plain words (fetched from `GET /api/auth/scopes`; honest fallback copy if the upstream is unset).
- **Session:** on load, `GET /api/auth/session` → `{login, allowlisted, admin}` drives a session record in the store (a real transition, actor `system`). Signed-in + allowlisted → the chat surface. Sign-out command.
- **Non-allowlisted:** honest state + one-click *request access* (`POST /api/identity/request-access`), confirmation shown, no dead end.
- All of it keyboard-complete and registered as commands (`auth.sign-in`, `auth.sign-out`, `auth.request-access`).
- **Local proof:** a stub identity upstream for `wrangler dev` + tests (clearly labeled test double honoring the contract routes) so the full journey — signed-out → sign-in → non-allowlisted → request-access → allowlisted → chat — is exercised in the worker e2e without real GitHub.

## 2. Money surfaces (against the billing contract — it is real, landed code)
Billing routes exist on branch `wave1-billing-deployable` of `/Users/williamcory/flows/ui` (read `workers/billing/DEPLOY.md` + `WAVE1-BILLING-RECEIPT.md`): `GET /api/billing/balance` (dollars, `state`, `allowedToStartWork`, credits list), `GET /api/billing/usage[?run=]` (per-run dollar costs). Proxy them through the product Worker (`BILLING_UPSTREAM_URL`, same seam pattern).

- Balance visible **in dollars** (no credit abstraction) in an unobtrusive persistent spot; per-turn/run cost shown on completed work (words + dollars, never a score).
- First-run line, stated once, plainly: *"You have $500 of usage on us."* **No card form anywhere, ever.**
- Drain-to-$0: when `allowedToStartWork:false`, the composer pauses new work with an honest one-line state; history, world docs, and everything already rendered remain fully accessible. A correction/turn attempt at $0 is a calm state, not an error explosion.
- Commands: `billing.balance` (shows the card), plus the balance card itself. Tests against a stub billing upstream honoring the real response shapes.

## 3. Approval round-trip (the Aug 13 demo dependency)
Today `forwardApprovalDecision` journals the decision client-side only. Make the round trip real through the product Worker:

- `POST /api/approvals/decision` on the Worker: forwards to the gateway upstream's `submitApproval` RPC (`/v1/rpc/submitApproval`, body `{runId, nodeId, iteration, decision:{approved, note?}}` — contract per `/Users/williamcory/smithers/packages/gateway/src/rpc/` and `docs/guides/custom-workflow-ui.mdx`) using the seam's identity injection. Honest 501 when no upstream.
- Client: ApprovalCard decision → command → POST → on success the card freezes with the decision stamp **from the server echo**; on failure the card shows a retryable honest error (never silently frozen, never fake-approved). Pending state while in flight.
- An approval card arriving as a `card` frame carries `{runId, nodeId, iteration}` in its payload (extend `src/shared/Cards.ts` compatibly).
- **Test-double gateway** in tests + worker e2e: assert the full loop — card frame in → decide → Worker forwards with injected identity → echo → card frozen. Also assert the deny path and the failure path.

## 4. Stop discipline
- Escape stops foreground work ≤1s and the UI says what it stopped (one line). Wire Escape → `chat.stop` command → cancel endpoint; the interrupted turn keeps partial text with the interrupted marker (exists) plus the "stopped X" statement.
- A turn that dies server-side (upstream disconnect mid-stream) surfaces as an honest failed state — never a silent stall. Test both.

## 5. Proofs + receipt
- `bun test src` green (with the new suites), `bun run typecheck` clean, `bun scripts/worker-e2e.ts` extended to cover: auth journey (stub), balance + $0 pause (stub), approval round trip (double), and reporting PASS lines for each.
- Commit in clean conventional commits on the current branch. Write `WAVE2A-RECEIPT.md`: what landed, proofs with observed output, contract assumptions made about the identity worker (list them explicitly so integration can verify), honest gaps.
