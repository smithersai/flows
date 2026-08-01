# `@smithers/engine-store`

This page is the public API reference for the journal-backed `FlowEngine` composition, deferred/clock state contract, and hermetic boundary contract. The current composition is Node-oriented.

## `EngineStore`

```ts
const layer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-a",
  isAlive: (owner) => checkOwner(owner)
})
```

`Options` contains `owner.hostId`, `journalSource`, and optional `isAlive`. `make(options)` returns a `FlowEngine` service; `layer(options)` provides both `FlowEngine` and `FlowEngine.SnapshotBoundary`.

Required services are `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, and `Scope`. `EngineCompositionError` represents an engine that was invoked without a complete composition.

The engine stores a versioned state envelope in each run row, fences run and attempt ownership, replays encoded exits, and writes engine decisions to the journal. Cache addresses are `Digest.digest(stepKey)`, not the raw `sk1_…` value.

Durable cancellation is observed, not just recorded: while a run executes, the driver polls `cancel_requested_at_ms` on the heartbeat cadence and cancels the run (interrupting the flow fiber) when another process has called `RunStore.requestCancel`. Terminal transitions are additionally guarded with `{ cancelRequested: "absent" }` inside the ownership CAS, so a request that races past the last poll turns finalize into a cancellation instead of a `completed`/`failed` write.

The driver's periodic sweep (heartbeat cadence) re-drives three durable shapes: parked runs whose cancellation was durably requested, runs parked with reason `released` (interrupt-released by shutdown, issue #39), and stale-running rows left by a hard-killed owner (issue #53) — each re-enters the ordinary claim/steal/activate path. A wake for a flow the sweeping process has not registered is not dropped silently: the driver logs a once-per-run structured warning (run id + flow name) and leaves the durable waiting row parked, so any process that registers the flow still reclaims the run (issue #62).

Every engine-store lifecycle journal write — run decisions, attempt started/finished, hard violations, snapshot identity, cache provenance, deferred completions, clock schedules, interruption records, and the `Inconsistency` cache-conflict record — takes the journal's durable channel (`emitDurable`), so a saturated lossy queue can never drop one. Attempt lifecycle writes additionally pass the owner, fencing the append on the run's persisted ownership: a reclaimed (zombie) owner fails with `fence_lost` and self-interrupts instead of appending.

## `DurableEngineState`

The service addresses deferreds by flow/execution/deferred name and clocks by flow/execution/clock name. It exposes:

- `deferred` and first-writer-wins `completeDeferred`
- `clock`, first-writer-wins `scheduleClock`, and `completeClock`
- `dueClocks(nowMs)`
- owner-fenced `park`, idempotent `wake`, `waiting`, and sweeper-ordered `waitingRuns` — the `WaitingRunsFilter` supports `reason`, `dueBeforeMs`, and a `cancelRequested` predicate over `flows_runs.cancel_requested_at_ms`, so sweepers fetch only actionable rows instead of scanning every parked run (issue #68)
- `staleRunningRuns(staleBeforeMs)` — run ids still `running` whose heartbeat froze before the horizon; the driver's periodic sweep re-drives these through the claim/steal path so a hard-killed owner (SIGKILL, OOM) cannot strand a run (issue #53)
- `recordRunParent(childId, parentId)` — durably records a parent edge in the run DAG (`flows_run_parents`), first-writer-wins per pair. The cycle check is **inside the same write transaction** as the insert: the child→parent chain is walked over the durable edges and on a hit the transaction rolls back and the call fails with the typed `RunParentCycleError` — so a rejected edge leaves no durable trace, and of two concurrent writers whose edges jointly close a cycle exactly one fails (issues #29/#40/#54/#55/#56). The driver maps this error to `FlowCycleDetected` and records the edge before creating the run row, so no `state_json` `parentExecutionId` can outlive a rejected edge
- `runParents(childId)` — the recorded edges, oldest first (`seq` is ordering-only)
- `removeRunParentsForRun(runId)` — deletes every edge naming the run as child **or** parent; the GC hook a lane that deletes run rows (time-travel pruning, retention) must call, since `flows_run_parents` deliberately has no FK to `flows_runs` (issue #66)

The run driver populates the waiting taxonomy on the execution path: a run
that suspends parks before its `suspended` transition — reason `timer` with
the earliest pending clock deadline as `wakeAt` when a durable clock is
outstanding, reason `event` otherwise — and every resume wakes (clears) the
waiting payload when the run re-enters `running`. `waitingRuns` and the
migration `0004` partial index therefore match real suspensions, not only
rows written through the store API directly.

Outcome unions distinguish newly written, existing, completed, and missing
rows. `make` and `layer` provide SQL persistence through `Database`;
`makeMemory(options?)` and `layerMemory` are deterministic in-memory
implementations that, given a `runs` lookup, enforce the same
`park`/`wake`/`scheduleClock` ownership fences as the SQL layer — both are
pinned by one shared contract suite
(`packages/engine-store/test/contract/DurableEngineStateContract.ts`).
Clock creation is fenced against the active run owner. Deferred and clock
completion use first-writer and compare-and-set admission before the existing
claim-gated wake path. A durable clock whose fire fails transiently is
redispatched with capped exponential backoff (Temporal timer-queue
semantics) rather than being lost until process restart.

## `StepBoundary`

<a id="stepboundary"></a>

`Descriptor` contains `readSet`, `writeSet`, and `boundaryMode` (`hard` or `expected`). A service implements:

```ts
interface Service {
  prepare(descriptor: Descriptor): Effect<PreparedBoundary, UnsupportedBoundary>
  settle(prepared: PreparedBoundary): Effect<BoundaryEvidence, UndeclaredWrite | UnsupportedBoundary>
  replayOutputs(evidence: BoundaryEvidence): Effect<void, UnsupportedBoundary>
}
```

`BoundaryEvidence` contains declared outputs, a diff identity, and an optional expected-set deviation. A hard undeclared write fails with `UndeclaredWrite`; expected mode records a deviation.

`make(service)` wraps an implementation. `layerTest(options?)` is deterministic and supports changed-path/deviation/replay assertions, but it does not enforce a real sandbox.

## Cache admission

EngineStore admits a cache record only when the activity is sealed, the boundary is hard, and no deviation occurred. Only a content-key record has an address another run can reproduce; an ordinal-key record remains run-local. A cache hit calls `replayOutputs` before returning the stored result.

Replaying a succeeded attempt row also converges the cache: if a crash landed between `attempts.finish` and `cache.put`, the restarted executor re-records the sealed completion (with fresh cache-provenance) instead of leaving the cache permanently behind the journal. A divergent first-recorded row still surfaces through the `Inconsistency` receiver, strict by default.

A persisted `failed` attempt row replays by rethrowing the persisted domain failure — never by readmission, so `AttemptAdmissionRejected` marks only genuinely mid-flight (`running`) rows. The `Fail` errors were schema-encoded before persistence, so their `_tag` survives the JSON round trip and `RetryPolicy` non-retryable matching applies on replay (issue #59). The composition also implements the engine's `activityLatestAttempt` (attempt counter resumes from the persisted sequence) and degrades `activityRetryOrigin` to the earliest surviving attempt row when a retention job pruned attempt 1 (issue #69).

See [Assembling a durable engine](../guides/durable-engine.md), [Implementation status](../architecture/implementation-status.md), and [Step keys](../concepts/step-keys.md).
