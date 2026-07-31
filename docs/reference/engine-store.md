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

Every engine-store lifecycle journal write — run decisions, attempt started/finished, hard violations, snapshot identity, cache provenance, deferred completions, clock schedules, interruption records, and the `Inconsistency` cache-conflict record — takes the journal's durable channel (`emitDurable`), so a saturated lossy queue can never drop one. Attempt lifecycle writes additionally pass the owner, fencing the append on the run's persisted ownership: a reclaimed (zombie) owner fails with `fence_lost` and self-interrupts instead of appending.

## `DurableEngineState`

The service addresses deferreds by flow/execution/deferred name and clocks by flow/execution/clock name. It exposes:

- `deferred` and first-writer-wins `completeDeferred`
- `clock`, first-writer-wins `scheduleClock`, and `completeClock`
- `dueClocks(nowMs)`
- owner-fenced `park`, idempotent `wake`, `waiting`, and sweeper-ordered `waitingRuns`

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

See [Assembling a durable engine](../guides/durable-engine.md), [Implementation status](../architecture/implementation-status.md), and [Step keys](../concepts/step-keys.md).
