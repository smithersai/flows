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

Every engine-store lifecycle journal write — run decisions, attempt started/finished, hard violations, snapshot identity, cache provenance, deferred completions, clock schedules, interruption records, and the `Inconsistency` cache-conflict record — takes the journal's durable channel (`emitDurable`), so a saturated lossy queue can never drop one. Attempt lifecycle writes additionally pass the owner, fencing the append on the run's persisted ownership: a reclaimed (zombie) owner fails with `fence_lost` and self-interrupts instead of appending.

## `DurableEngineState`

The service addresses deferreds by flow/execution/deferred name and clocks by flow/execution/clock name. It exposes:

- `deferred` and first-writer-wins `completeDeferred`
- `clock`, first-writer-wins `scheduleClock`, and `completeClock`
- `dueClocks(nowMs)`

Outcome unions distinguish newly written, existing, completed, and missing
rows. `make` and `layer` provide SQL persistence through `Database`;
`makeMemory` and `layerMemory` remain deterministic test implementations.
Clock creation is fenced against the active run owner. Deferred and clock
completion use first-writer and compare-and-set admission before the existing
claim-gated wake path.

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

See [Assembling a durable engine](../guides/durable-engine.md), [Implementation status](../architecture/implementation-status.md), and [Step keys](../concepts/step-keys.md).
