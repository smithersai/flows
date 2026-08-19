# Wave 15 — one backend: the browser chain on a metered Cerebras relay

2026-08-19 · Worker `smithers-mvp-web` version `e84ad45e-0311-4eed-b326-dc0bc80aeec9`
· <https://canary.smithers.sh> · deploy receipt
`apps/server/deploy-receipts/2026-08-19T22-45-46-498Z.json`

**Bottom line:** the chat has one backend. The agent loop runs in the browser as
an Agent Chain, it spends its model on `POST /api/model/stream`, and that route
forwards to the same managed-inference upstream `/api/agent/turn` used — the
canary chat Worker, which owns the Cerebras key, authorizes the balance before
the provider call, and meters the usage durably onto the signed-in user's own
account. **No provider credential is bound on the product Worker.** The
`/debug.backend proxy | chain` switch is gone; the flow reports instead.

## What was broken

`/api/model/stream` forwarded to `api.anthropic.com` behind
`MODEL_RELAY_API_KEY`, a secret canary never had, so every chain turn answered
501 and the chat worked only on the server-side proxy backend
(`apps/ui/canary-repros/admin/26.1.md`, `26.6.md`).

## The decision, and where it deviates from the brief

The brief said to bind `CEREBRAS_API_KEY` on the product Worker. It also said to
reuse `/api/agent/turn`'s client, config, and metering rather than inventing a
second one. Those two pull apart, because the turn path does not talk to
Cerebras itself — it talks to the chat Worker, which does.

Reusing that upstream was chosen, and no secret was bound. It is what the brief
asked for on the point that matters (a Cloudflare endpoint we own, proxying to
the Cerebras endpoint we use), and it is strictly better on the two things the
Wave 7 post-deploy correction was written about:

- **Credential surface.** The browser-facing Worker holds no provider key. There
  is no configuration of it that can leak one, because there is none to leak.
- **Metering.** The relay inherits the turn path's metering exactly: balance
  authorized before the provider call, authoritative usage enqueued on the
  durable queue, charge attributed to the vouched login. A relay that called
  Cerebras directly would have needed billing's money-writing
  `METERING_SERVICE_TOKEN` on the browser-facing Worker, and its own retry and
  idempotency logic, to arrive somewhere worse.

The relay mints the run id itself. Upstream derives the charge's idempotency key
from it, so a caller that could choose it could replay one receipt and take
every later call for free.

## Gate order on the route (unchanged, now covered)

1. Anonymous → `401`, signed-in-but-not-allowlisted → `403`, both decided before
   any upstream byte is spent.
2. Per-login ceiling (`TurnRateLimiter`), same budget as the turn path.
3. Sealed-step law: a tool-bearing body is `400`, and nothing is forwarded.

The ceiling's unit changed with the backend and was re-sized: it counts model
calls, not messages, because a chain turn authors a link per step. It was 120,
which a heavy hour of chat now reaches; it is 1000, which keeps the ten-times
headroom the guard has always claimed. A spent window is about a dollar at the
alpha's rate card.

## Live verification

Signed in as `codeplanesmithers` (allowlisted, admin) on
<https://canary.smithers.sh>, sent "Reply with exactly: PONG-chain":

| what | observed |
|---|---|
| the turn | streamed and completed; `PONG-chain` rendered in the transcript |
| transport | `["POST /api/model/stream"]` — and **zero** calls to `/api/agent/turn` |
| errors | no response >= 400, no console error |
| billing `chargeCount` | 1981 → **1983** (input + output token lines, rate card `2026-08-09.1`) |
| billing `totalUsd` | 543 → 543 |

The balance does not move **by design**: interactive chat is complimentary
("metered at true supplier cost, on us" — the account's own
`freeAtZeroBalance`). The two new charge lines on `codeplanesmithers`'s own
account are the metering proof, and they are the trusted-caller attribution the
relay now carries.

Screenshot: `/tmp/canary-chain-live.png`. Re-runnable:
`PROF=/tmp/canary-access-profile bun apps/ui/canary-repros/admin/26.1.ts`.

## Gates

- `apps/server`: `tsc --noEmit` clean, 386 tests pass.
- `apps/ui`: `tsc --noEmit` clean, 718 tests pass.
- `packages/model`: `tsc -b` clean, 104 tests pass.
- e2e `E3.13+E3.14` passes, including a whole browser chain turn driven through
  the product's own wiring against the stub upstream. Four suites pass, eight
  fail — see the gaps below for which failures this change caused and which it
  inherited.

## Honest gaps

- **`/api/agent/turn` still exists.** The browser never calls it, but the
  terminal client (`apps/tui`) and the native shell do, and removing the route
  would break them. `apps/ui/src/mainview/native/WebAgent.ts` remains as that
  seam's client — nothing under `src/mainview` composes it — and the e2e corpus
  still drives it. Retiring the seam is a separate piece of work that has to
  move the TUI first.
- **Five browser-driven e2e suites are red, and this change is why.** They drive
  the real SPA, which now runs the chain, while their fixtures still script the
  proxy's vocabulary: prose deltas the chain reads as a failed authoring
  attempt, and `card` frames pushed from the upstream, which the chain has no
  notion of at all. On the chain a card comes from a catalog call inside the
  flow script — the model cannot push one — so this is a real change in what the
  product does, not only in what the fixtures say.

  | suite | file | what it pins |
  |---|---|---|
  | E4.5-E4.9 | `cards-copy.e2e.ts` | settled/plan/blocked card copy |
  | E4.1/E4.10/E4.11 | `cards-approvals.e2e.ts` | approval cards on a streamed turn |
  | E13-E14 | `a11y-resilience.e2e.ts` | keyboard journey, dropped stream, retry |
  | E2.4-E2.9 | `reco-actions.e2e.ts` | the agent's tool call opening the chooser |
  | E3.9 | `turn-failure.e2e.ts` | retry re-POSTs a turn |

  Porting them means re-deciding what each fixture means on the chain's render
  path, which is a piece of work in its own right.
  `openClient({ backend: "chain" })` exists and E3.13 uses it; that is the
  starting point, not the finish.

  Three other suites are red for reasons unrelated to this change (E9's World
  close affordance, E11's `/keys.list`, E1's expired-session balance read) —
  they were red on the concurrent lane's tree before this landed.
- **`/clear`'s memory sweep** moved onto `/api/model/stream` but is still a
  plain model call rather than an authored flow (DESIGN.md §14).
