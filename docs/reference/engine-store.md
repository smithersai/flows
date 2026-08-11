# `@smthrs/engine-store`

This page is the public API reference for the journal-backed `FlowEngine` composition, deferred/clock state contract, and hermetic boundary contract. The current composition is Node-oriented.

## Node only

`@smthrs/engine-store` is a **Node entry point**, and the repository's browser gate treats it as one. `EngineStore` reads `process.pid` and imports `randomUUID` from `node:crypto` (`packages/engine-store/src/EngineStore.ts:20`); those two are the package's entire browser-gap inventory (issue #114). Everything it composes above — `@smthrs/crypto`, `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/step-cache`, `@smthrs/database`, and `@smthrs/engine` — is browser-bundleable, so the gap is an owner-identity and UUID-source decision, not a rewrite. Until it closes, do not describe the durable engine as browser-capable; `npm run browser` asserts this entry point still fails to bundle for the browser, so the claim cannot drift. See [browser support](../architecture/browser-support.md).

## `EngineStore`

```ts
const layer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-a",
  isAlive: (owner) => checkOwner(owner)
})
```

`Options` contains `owner.hostId`, `journalSource`, and required `isAlive`. `make(options)` returns a `FlowRuntime` service — the port `@smthrs/flow` declares; `layer(options)` provides both `FlowRuntime` and `FlowEngine.SnapshotBoundary`. The liveness probe is mandatory because silently treating an unknown owner as alive can strand recovery forever.

Required services are `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, and `Scope`. `EngineCompositionError` represents an engine that was invoked without a complete composition.

The engine stores a versioned state envelope in each run row, fences run and attempt ownership, replays encoded exits, and writes engine decisions to the journal. Cache addresses are the injected `Sha256` transformation of the step key, not the raw `key1_…` value.

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
- `recordRunParent(childId, parentId)` — durably records a parent edge in the run DAG (`flows_run_parents`), first-writer-wins per pair. The cycle check is **inside the same write transaction** as the insert: the child→parent chain is walked over the durable edges and on a hit the transaction rolls back and the call fails with the typed `RunParentCycleError` — so a rejected edge leaves no durable trace, and of two concurrent writers whose edges jointly close a cycle exactly one fails (issues #29/#40/#54/#55/#56). The driver maps this error to `FlowCycleDetected` and records the edge before creating the run row, so no `state_json` `parentExecutionId` can outlive a rejected edge. Edge insert and run-row creation run inside **one** storage transaction (`DurableEngineState.transaction`), so a crash between them cannot leave a durable orphan edge for a run that was never created (issue #80). Serialized write transactions are a documented requirement of the `DurableWriter.write` contract, not a SQLite artifact — a Postgres-backed implementation must use `SERIALIZABLE` (issue #74)
- `runParents(childId)` — the recorded edges, oldest first (`seq` is ordering-only)
- `removeRunParentsForRun(runId)` — deletes every edge naming the run as child **or** parent, for lanes that clear edges without deleting the run row. Because `flows_run_parents` deliberately has no FK to `flows_runs`, GC is additionally enforced in the database: an `AFTER DELETE` trigger on `flows_runs` prunes the deleted run's edges in the same transaction, so a lane that never calls this hook still cannot leave ghost edges in a future cycle walk (issues #66/#81)

The run driver populates the waiting taxonomy on the execution path: a run
that suspends parks before its `suspended` transition — reason `timer` with
the earliest pending clock deadline as `wakeAt` when a durable clock is
outstanding, reason `event` otherwise — and every resume wakes (clears) the
waiting payload when the run re-enters `running`. `waitingRuns` and the
waiting-row partial index therefore match real suspensions, not only
rows written through the store API directly.

Outcome unions distinguish newly written, existing, completed, and missing
rows. `make` and `layer` provide SQL persistence through `DurableWriter` and Effect's `SqlClient`;
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

`FileBoundary` from `@smthrs/engine/FileBoundary` contains `readSet`, `writeSet`, and `boundaryMode` (`hard` or `expected`). A service implements:

```ts
interface Service {
  prepare(descriptor: FileBoundary): Effect<PreparedBoundary, UnsupportedBoundary, Crypto>
  settle(prepared: PreparedBoundary): Effect<BoundaryEvidence, UndeclaredWrite | UnsupportedBoundary>
  replayOutputs(evidence: BoundaryEvidence): Effect<void, UnsupportedBoundary | BoundaryCorruption>
}
```

`BoundaryEvidence` contains declared outputs, a diff identity, optional expected-set deviation, and optional `wholeTreeWritesVerified: true`. A hard undeclared write fails with `UndeclaredWrite`; expected mode records a deviation. Cross-run cache admission requires the explicit whole-tree proof.

`make(service)` wraps an implementation. `layer` is the filesystem-backed production boundary over the kernel `FileSystem` seam: `prepare` measures the declared read set's real digests, `settle` detects declared reads mutated outside the declared write set and captures the write set's post-state as materializable outputs, and `replayOutputs` re-materializes them. It cannot detect writes elsewhere in the tree, so it omits the whole-tree proof and its results remain run-local rather than entering the shared cache. Whole-tree undeclared-write detection still needs a stronger jj-diff-backed boundary. `layerTest(options?)` is deterministic and supports changed-path/deviation/replay/`readSnapshot` assertions, but it does not enforce a real sandbox.

## Cache admission

EngineStore admits a cache record only when the activity is sealed, the boundary is hard, no deviation occurred, and the evidence explicitly carries `wholeTreeWritesVerified: true`. Older evidence and boundaries that observe declared paths only are conservatively refused. Only a content-key record has an address another run can reproduce; an ordinal-key record remains run-local. A cache hit is verified before it is served (issue #90): the store calls `prepare` and compares the descriptor's declared `readSet` against the `readSnapshot` the host measured. Reuse happens only when every declared read still matches — reads the host reports but the declaration never claimed are ignored, while a declared path that is missing or has a different digest refuses the hit, journals a `cache-provenance` record with `action: "stale_read_set"`, and falls through to a real execution. That is Skyframe's dirty-check invariant; the key alone only detects a *changed declaration*, not a stale one. A verified hit calls `replayOutputs` before returning the stored result.

Replaying a succeeded attempt row also converges the cache: if a crash landed between `attempts.finish` and `cache.put`, the restarted executor re-records the sealed completion (with fresh cache-provenance) instead of leaving the cache permanently behind the journal. A divergent first-recorded row still surfaces through the `Inconsistency` receiver, strict by default.

A persisted `failed` attempt row replays by rethrowing the persisted domain failure — never by readmission, so `AttemptAdmissionRejected` marks only genuinely mid-flight (`running`) rows. The `Fail` errors were schema-encoded before persistence, so their `_tag` survives the JSON round trip and `RetryPolicy` non-retryable matching applies on replay (issue #59). The composition also implements the engine's `activityLatestAttempt` (attempt counter resumes from the persisted sequence) and degrades `activityRetryOrigin` to the earliest surviving attempt row when a retention job pruned attempt 1 (issue #69).

See [Assembling a durable engine](../guides/durable-engine.md), [Implementation status](../architecture/implementation-status.md), and [Step keys](../concepts/step-keys.md).

## Migrations and internal scheduling

`@smthrs/engine-store` owns `flows_deferred_completions` and
`flows_clock_deadlines` — the persisted `DurableDeferred`/`DurableClock` state
`internal/DeferredPersistence` operates and no other package reads — and
reserves migration id block `3000`. Because it composes every storage package,
`Migrations.sets` is also the complete durable engine schema in dependency
order (journal, run store, step cache, then its own) and `Migrations.layer`
installs all of it. See [`@smthrs/database`](database.md) for how the
namespaced sets compose without colliding.

`internal/RunCoordinator` lives here rather than in a storage package because
it is in-memory scheduling, not persistence: `make({ drain })` deduplicates
in-process work by key and exposes `active`, `run`, `wake`, and `interrupt`
around scoped fibers. `RunDriver` is its only consumer. It is not distributed
ownership; that is [`@smthrs/run-store`](run-store.md)'s `RunStore`. The shape
is adapted from opencode's `packages/core/src/session/run-coordinator.ts`,
which also lives in the session layer.
