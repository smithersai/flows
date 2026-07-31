# @smithers/engine-store

@smithers/engine-store composes the encoded flow engine with journal-backed
run ownership, attempts, cache provenance, and event records. It also supplies
durable deferred and clock state and the step-boundary contract.

```text
EngineStore.layer(options)
├─ RunDriver: RunStore + RunCoordinator
├─ ActivityPersistence: AttemptStore + CacheStore + StepBoundary + Jj
├─ DeferredPersistence: DurableEngineState + Journal + resume scheduling
└─ FlowEngine.makeUnsafe(encoded)
```

The layer requires Journal, RunStore, AttemptStore, CacheStore,
DurableEngineState, StepBoundary, Jj, and Scope. EngineStore.make returns the
typed FlowEngine service. EngineStore.layer also provides SnapshotBoundary.

```ts
const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store",
  isAlive: (owner) => probe(owner)
})
```

owner.hostId is the host identity used by the liveness probe. The
implementation adds process id and a fresh nonce. Registrations and active
fibers are process-local; encoded run state, attempts, deferreds, clocks,
ownership, and journal records come from the supplied layers.

DurableEngineState.layer persists deferred completions and absolute clock
deadlines through Database after Journal.Migrations has run.
DurableEngineState.layerMemory remains the deterministic in-memory test
implementation. StepBoundary.layerTest() is a deterministic test boundary.
Production activity dispatch is content-keyed for sealed activities with
identity, and ordinal-keyed otherwise. Compensable activities require
SnapshotBoundary; irreversible retries require an activity idempotency key.

See the [reference](../../docs/reference/engine-store.md) for the exact
contracts, outcomes, persistence order, and explicit exclusions.
