# Smithers engine-replacement gap analysis

The maintainer's question: **what are we missing to truly support replacing the
internal engine in smithers (`~/smithers`, read-only reference) with the flows
engine?** This page re-verifies the pre-hardening audit ledger against the
current tree — after the issues fix wave and the round-1 hardening wave both
landed — and closes with a migration sequence, the plugin-absorption list, and
an honest "not soon" list. Statuses cite current source; smithers-side line
references come from the audit's partial reads (`engine.js` resume/claim
~7161–7230, `adapter.js` `claimRunForResume` ~1722, `insertEventWithNextSeq`
~3514, attempts ~2252–2340) and are directional, not pinned.

Companion pages: [implementation-status](implementation-status.md) for the
authoritative per-area status table, [plugin-system](plugin-system.md) for the
hook catalog this analysis leans on.

## Ledger re-verification

| # | Audit area | Pre-hardening status | Status now |
| --- | --- | --- | --- |
| 1 | Waiting-reason taxonomy | partial | **closed** |
| 2 | Fenced claim + owner liveness | fencing only; liveness missing | **closed** (lease/heartbeat), one browser caveat |
| 3 | Journal append fencing | missing | **closed** |
| 4 | Pause / cancel / hijack with attribution | missing | **partial** — cancel closed, pause = park, hijack + attribution missing |
| 5 | Continue-as-new lineage | missing | **partial** — lineage edge closed, `Continued` terminal missing |
| 6 | Checkpoints / worktree lanes | partial | **still missing** (hook seam exists) |
| 7 | Quota park / wake | missing | **partial** — store side closed, wake driver missing |
| 8 | Supervisor sweep | missing | **still missing** (primitives ready) |
| 9 | Fault-suite harness | partial | **closed as harness**; case parity accretes with features |

### 1. Waiting-reason taxonomy — closed

Closed by migration `0004_waiting_reason`
(`packages/journal/src/migrations/0004_waiting_reason.ts`, commit `36fb342`).
`DurableEngineState.park` / `wake` / `waiting` / `waitingRuns` round-trip
`{ reason, wakeAt?, token? }` with `approval | event | timer | quota` reasons,
an index on `(waiting_reason, waiting_wake_at_ms)` built for a sweeper query,
and `WaitingReason.test.ts` covering per-reason round-trips, non-owner park
rejection, and the due-quota-run query. This is exactly the audit's "done"
definition. Smithers' inline per-reason states in `engine.js` (pinned by
`e2e/faults` restart-waiting-approval/event/timer) are replaced by the one open
taxonomy, per the pluggability rule.

The production park path reaches the full taxonomy through
`FlowEngine.annotateWaiting` (issue #31): a flow declares
`{ reason, wakeAt?, token? }` immediately before suspending and the driver
parks the run with exactly that payload (`AnnotatedWaiting.test.ts` pins the
approval-with-token and due-quota sweeps end-to-end); without an annotation the
driver derives `timer`/`event` from durable clock state.

### 2. Fenced claim and owner liveness — closed, one caveat

`RunStore.claimAndOwn` (PR #7) carries the fence; the hardening wave added the
lease half the audit called missing: `heartbeat_at_ms` with a 30s staleness
window (`packages/journal/src/RunStore.ts:334`), stale-owner steal inside the
claim's `WHERE` clause (`RunStore.ts:637,692,818`), and a fenced `heartbeat`
operation. No pid probing anywhere — the audit's explicit rejection of
smithers' pid-verified `runState` (`packages/db/src/runState`) holds. Fault
coverage: `FaultMatrix.test.ts` proves fence loss at heartbeat, `attempts.put`,
and `attempts.finish` leaves exactly one durable completion.

**Caveat:** `EngineStore` still uses `process.pid` and `node:crypto`
(see [implementation-status](implementation-status.md) cautions), so the
browser-host requirement is not yet met by the store itself, and cross-host
liveness (`EngineStore.Options.isAlive`) is application-supplied. Done =
identity from `Random`/crypto layer instead of pid, and a default `isAlive`
derived from lease expiry alone.

### 3. Journal append fencing — closed

Closed by `ae8a41d` ("fence run-scoped writes on ownership and split the lossy
emit channel") plus the issue-#3 `emitDurable` that allocates the canonical
sequence inside the write transaction. `JournalFencing.test.ts` and the
`FaultMatrix` claim-takeover case ("owner B claims while owner A is executing,
and A's later writes cannot corrupt state") prove the zombie-owner invariant
the audit demanded — temporal's shard fencing expressed as a `WHERE` clause,
as prescribed. Smithers' `insertEventWithNextSeq` (~3514) has no fencing at
all; flows is now strictly ahead here.

### 4. Pause / cancel / hijack with attribution — partial

- **Cancel: closed.** `cancelRequested` is a durable unfenced request on the
  run row, observed by guarded transitions inside the CAS
  (`RunStore.ts:250,871`) — a stronger shape than smithers' cancel.
- **Pause: effectively available** as `park(reason)` over §1's taxonomy, but
  there is no user-facing pause verb and, critically, **no attribution** —
  no actor/why fields on the park or the control event.
- **Hijack: missing**, by design deferred to the plugin surface. The
  `runControl` hook (sequential) already exists in the engine hook catalog
  (`packages/plugin/src/Hooks.ts:357`), so the seam is named; nothing
  dispatches it yet.

Done = a small `RunControl` service that journals an attributed control event
(actor, reason) and flips `DurableEngineState`, with hijack shipping as a
plugin over `runControl`. Smithers evidence: pause and hijack fault cases plus
who/why columns on the run row.

### 5. Continue-as-new lineage — partial

`flows_runs.parent_run_id` landed (`7aa944d`; `RunStore.ts:104–120`), and the
docstring explicitly names it "the lineage edge a fork, rewind, or
continue-as-new child" records. `SqlTimeTravelStore.createFork` writes it.
Missing: a `Continued` terminal status/journal event that closes the parent
run, and automatic lineage recording from ordinary engine execution (listed
under planned integration). Done = `Continued` terminal + a restart-lineage
fault case, matching smithers' continue-as-new and fork fault pins.

### 6. Checkpoints and worktree lanes — still missing

The largest remaining functional gap versus smithers' Tier-1 durability
snapshots (`snapshot-hook`), restore/revert/rewind, and `smithers worktree`
lanes. What exists on our side: the `checkpoint` hook (sequential) in the
catalog, the time-travel package's fork/rewind/replay over stored state, and
`Jj` in host. What is missing: a `Checkpoint` host capability (layer-gated,
`makeNoop` for browser) that actually snapshots agent-session/worktree state at
step boundaries, and any worktree-lane lifecycle. `StepBoundary` also remains a
contract with no production host layer. Done = the Checkpoint capability
invoked only via the `checkpoint` hook, never inline in the loop.

### 7. Quota park / wake — partial

The store half is done and was designed for exactly this: `quota` is a
first-class waiting reason, and `waitingRuns` answers "which quota-parked runs
are due" (`WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <= now`,
covered by a test). Durable clock rows with restart re-arming also already
ship. Missing: the plugin that classifies a provider quota error → parks with
`wakeAt` → wakes via the durable clock. Done = that plugin over the `waitStart`
/ `wake` hooks, with one park-then-wake fault case; nothing new in core.

### 8. Supervisor sweep — still missing

No `Supervisor` layer exists in `packages/engine`. But every primitive it
needs landed: stale-lease steal in `claimAndOwn`, the `waitingRuns` due-run
query, and the taxonomy index built for the sweeper (the migration's own
docstring says so). Done = a scheduled Effect fiber — scan expired
leases/due wakes → `claimAndOwn` → resume — as an opt-in `Supervisor.layer`,
replacing smithers' `apps/cli/src/supervisor.js` claim-by-proxy process (the
audit's explicit rejection of a separate CLI app stands). This is now a small
task, not a subsystem.

### 9. Fault-suite harness — closed as harness

The P0 harness the audit demanded exists: `Journal.Notifying.wrap`/`layer`
injects interstitial crashes and fence loss around any Effect service, and
`FaultMatrix.test.ts` (15 cases) plus `DurableWaitingRestart`,
`WaitingReason`, and `Ownership` tests pin crash/restart invariants
deterministically — the bazel `GraphTester` shape. Parity with smithers'
`e2e/faults` enumeration is partial only where the underlying feature is
missing: no pause, hijack, quota-wake, or continue-as-new lineage cases yet.
Cases accrete as §§4–7 land; the harness itself is no longer a gap.

## New gaps the audit did not list

1. **Plugin dispatch is unwired.** The `@smithers/plugin` kernel ships
   (`985adb5`) with the full catalog, but the engine call sites still use
   built-in defaults. Since pause attribution, hijack, quota, and checkpoints
   are all specified *as plugins*, wiring dispatch at the seams is the
   gating dependency for half this ledger.
2. **No packaged production layer.** Nothing composes database + migrations +
   journal + engine-store + kernel + Host + engine into one importable layer.
   Smithers cannot adopt the engine as a dependency until this exists — it is
   the literal cutover artifact.
3. **Handler re-registration on restart.** Flow registrations are in-memory; a
   restarted process must re-register before driving stored runs. Smithers'
   resume path assumes the engine can pick up any persisted run; the cutover
   shim must guarantee registration-before-resume.

## (a) Recommended migration sequence

Move storage first, loop second, operations third — each stage runs under the
existing smithers CLI unchanged.

1. **Journal + run rows under smithers (shim: adapter-compat layer).** Replace
   `adapter.js`'s `insertEventWithNextSeq`, `claimRunForResume`, and attempt
   tables with `@flows` Journal/RunStore/AttemptStore behind a compat module
   that preserves `adapter.js`'s call signatures. flows is strictly stronger
   here (fencing, in-transaction seq, lease steal), so this is a pure win and
   de-risks everything after. Shims needed: an event-shape translator
   (smithers event rows ↔ journal producer events) and a one-shot data
   migration for live runs.
2. **Engine loop for new runs only (shim: dual-engine routing).** New runs
   execute on `Engine.FlowEngine` + `DurableEngineState`; existing runs finish
   on the old loop. Requires the packaged production layer and the
   registration-before-resume guarantee. Waiting states route through the
   taxonomy instead of `engine.js`'s inline cases.
3. **Supervisor + RunControl (retire `supervisor.js`, `pause`, `cancel`
   paths).** `Supervisor.layer` replaces the claim-by-proxy process;
   `RunControl` replaces pause/cancel with attribution. The smithers CLI verbs
   become thin RPC over the layer.
4. **Time travel + checkpoints last.** `snapshot-hook`, restore/revert/rewind,
   and worktree lanes move onto the `Checkpoint` capability and the
   time-travel stores. Last because it has the largest missing surface (§6)
   and the least crash-safety risk while both systems coexist.

## (b) Gaps the plugin system should absorb

Per [plugin-system](plugin-system.md), these belong on hooks, not in core:

- **Hijack** — a plugin over `runControl` (§4).
- **Quota park/wake** — a plugin over `waitStart`/`wake` + durable clock (§7).
- **Checkpoint triggering** — the `checkpoint` hook decides when; core only
  provides the host capability (§6).
- **Provider-specific error classification** (quota vs transient vs fatal) —
  `classifyError` / `resolveRetry`, keeping smithers' hard-won provider quirks
  out of the loop.
- **Approval UX** — `waitStart(reason: "approval")` plus an external resolver;
  core only parks and wakes.

Core keeps: the taxonomy, fencing, leases, `RunControl`'s journaled verbs, the
supervisor, and the `Checkpoint` capability itself.

## (c) Not soon — honest list

- **Worktree-lane parity** (`smithers worktree` reclaim, per-lane isolation):
  depends on §6 plus jj lifecycle design; no near-term path.
- **Cross-run hermetic caching / output materialization** and the static
  planner API: planned, not started.
- **Event-driven `resumeSignal`**: polling remains the fallback.
- **Journal compaction/checkpointing** for unbounded histories.
- **Edge/serverless deployment parity** (runnable Cloudflare engine-store,
  fully durable Vercel deferreds/clocks).
- **Smithers' UI-adjacent engine features** (live gateway mirroring, eval
  suites, GEPA optimization): out of engine scope entirely; they stay in
  smithers and consume the engine's sync/journal streams.

## Verdict

Of the audit's nine areas, four are fully closed (taxonomy, liveness, journal
fencing, fault harness), three are partial with the hard half done (control
verbs, lineage, quota), and two remain (checkpoints, supervisor — the latter
now trivial). The durability core is at or above smithers parity; what stands
between here and cutover is integration, not invariants: wire plugin dispatch,
package the production layer, and ship the small `Supervisor`/`RunControl`
layers, then begin stage 1 of the migration immediately — the storage swap is
already a strict upgrade.
