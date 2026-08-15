# Wave 6c receipt — the server-side kill route (launch checklist B-3)

**Result: B-3 passes against the live stack; B-1/B-2 still pass; `bun test src` 171/171; typecheck clean.**

## The bug

`POST /api/agent/turn/cancel` answered **500** (proven in
`~/flows/ui/WAVE6B-HARNESS-RECEIPT.md`): `handleCancel` called `abort()` on an
`AbortController` created inside the *turn* request's handler, and workerd
forbids cross-request I/O. A server-side kill was impossible through the
route; the turn streamed to `done:stop` regardless.

## The mechanism, and why it is workerd-legal

A small **Durable Object**, `TurnCancelRegistry` (`src/worker/index.ts`),
keyed one-per-`runId` by `idFromName`, holds the cancellation state in its
transactional storage (`active` / `cancelled` / `settled`, with a 10-minute
stale-active TTL so a crashed turn never holds its runId hostage). It is the
one shared store two requests may both reach:

- **Cancel route** (`handleCancel`) only flips DO state: `cancelled` if the
  turn is registered active, honest `not-found` for an unknown, settled, or
  stale runId. It never touches the turn request's I/O, so it can never 500.
- **Turn handler** (`handleTurn` + `tagRunId`) registers the runId with the
  DO (the DO is also the cross-isolate authority for the duplicate-turn 409),
  then its streaming pump re-reads the DO **between chunks and on a 500 ms
  timer tick while the upstream is silent** — every one of those reads is the
  turn request's own subrequest, which workerd allows. The poll is
  rate-limited to at most one per 500 ms *and* at least one per 64 chunks: a
  Worker request may make only ~1000 subrequests, and a token-streamed turn
  delivers far more chunks than that, so an unthrottled per-chunk poll would
  end long turns with "Too many subrequests"; the chunk-count floor keeps the
  check alive even though workerd's clock only advances on I/O. On
  `cancelled` the pump aborts **its own** upstream fetch (same request
  context: legal), enqueues the honest terminal frame
  `{type:"done", reason:"cancelled", runId}`, and closes. Bound latency:
  ≤ one poll tick (500 ms) even for a stalled upstream. A terminal upstream
  `done`, stream end, or client disconnect **settles** the entry — settle is
  awaited before the terminal frame is enqueued, so a tool-loop continuation
  leg re-POSTing the same runId the instant it reads `done` never meets a
  stale 409.
- **Client disconnect** is unchanged: `request.signal` still aborts the
  upstream fetch directly (`handleTurn`'s own listener, always legal), and
  the WebAgent's local abort path is untouched.

The alternative considered — keeping the in-isolate `Map` and catching the
cross-request error — cannot work: workerd's refusal is structural, not a
thrown exception to route around. The in-isolate map remains only as the
fallback when the binding is absent (bun unit tests); `wrangler.jsonc` binds
`TURN_CANCELS` on every real deployment (`migrations: v1 new_sqlite_classes`).

## The client renders the kill honestly

`AgentTurnDoneReasonSchema` gains `"cancelled"` (`src/shared/NativeAgent.ts`).
`AppController` maps a `done` with `reason:"cancelled"` to
`message.response.cancelled` (actor `system`, detail "That turn was stopped
by the server.") — the existing interrupted pattern: partial text kept,
status `interrupted`, "Turn interrupted — That turn was stopped by the
server.", session back to idle. Two ways that pattern could still read as
silence are closed:

- A kill outranks a pending tool call. The injected terminal frame can land
  between the model's `tool_call` frame and the upstream's own `done`; the
  tool-loop continuation branch ran first, so the killed turn would have
  executed the tool and re-POSTed another leg — carrying on after its own
  kill. The continuation now yields to `reason:"cancelled"`.
- A kill that beats the first delta has no response message to mark up, and
  the reducer used to no-op. It now inserts the interrupted message with the
  honest line, the same discipline `session.turn.orphaned` already used for
  "died before the first delta" (checklist B-1).

## Proofs

- **Unit** (`bun test src`, 171 pass): DO state machine (register / duplicate
  refused / cancel / not-found / settle re-registers / stale-active frees the
  runId); route-level mid-stream kill against a hanging upstream — cancelled
  answer, `done:cancelled` terminal frame, upstream reader actually
  cancelled, late kill not-found; settled-turn kill not-found; registry-path
  409; a 400-chunk stream spending <50 DO subrequests rather than one per
  chunk; client `done:cancelled` → interrupted message + idle phase; a kill
  during a pending tool call stopping the turn (one leg, no tool run, no act
  line); a kill before the first delta still describing the turn. Each of the
  three regression tests was confirmed red against the pre-review worker and
  client sources.
- **Worker e2e** (`bun scripts/worker-e2e.ts`, PASS): real `wrangler dev`
  with the DO bound, slow stub upstream — mid-stream kill ends the stream
  with `done:cancelled` (never `done:stop`), late kill not-found; then the
  REAL client (store + controller + WebAgent): runId captured off the wire,
  kill through the route, the UI store records the turn `interrupted` with
  the honest line and the session returns to idle. (The e2e also now seals
  every seam var so a local `.dev.vars` can no longer leak live-stack
  upstreams into Phase A's "no seams configured" premise.)
- **Live stack** (`http://localhost:8788`, hot-reloaded): a `slow-turn:` turn
  killed mid-flight answered `{"status":"cancelled"}`; the stream ended
  `done:cancelled`; a late kill answered `not-found`.
- **Launch checklist section B** (from `~/flows/ui`, branch
  `wave5-billing-bridge`, session re-minted):
  `SMITHERS_MVP_BASE_URL=http://localhost:8788 SMITHERS_MVP_STORAGE_STATE=/tmp/mvp-storage-state.json SMITHERS_CHAT_MODE=stub npx playwright test -c playwright.launch-checklist.config.ts section-b`
  → **7 passed (11.1s)** — B-1, B-2, **B-3**, B-4, B-5, B-6, B-7. Re-run
  after the review fixes against a freshly `vite build`-ed `dist` and a
  restarted `wrangler dev --port 8788`, so the browser drove the current
  client code, not a stale bundle.

## Honest gaps

- A turn whose client disconnects without the stream's `cancel` running
  (isolate kill) leaves a stale `active` entry until the 10-minute TTL; a
  cancel in that window answers `cancelled` for an already-dead turn. Harmless
  (the kill is idempotent and runIds are per-turn UUIDs) but stated.
- The kill latency bound is the 500 ms poll tick plus, on a stream chattier
  than one chunk per 500 ms, up to 64 chunks of slack — still well inside the
  checklist's few seconds. A slower upstream that ignores abort keeps its
  socket until workerd reaps it, but the client-visible stream is already
  honestly closed.
- A kill that races the upstream's own terminal `done` can answer `cancelled`
  to a turn that then settles normally: the pump stops polling once settled,
  so the client sees `done:stop`. Inherent to a two-request race; the window
  is one poll interval and the turn is honestly reported either way.
- The dev boundary (`src/server/AgentApi.ts`, single-process Vite proxy)
  keeps its in-process cancel; it never had the cross-request problem.
