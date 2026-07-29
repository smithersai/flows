# @flows/engine-store

@flows/engine-store composes the encoded workflow engine with journal-backed
run ownership, attempts, cache provenance, and event records. It also supplies
durable deferred and clock state and the step-boundary contract.

```text
EngineStore.layer(options)
├─ RunDriver: RunStore + RunCoordinator
├─ ActivityPersistence: AttemptStore + CacheStore + StepBoundary + Jj
├─ DeferredPersistence: DurableEngineState + Journal + resume scheduling
└─ WorkflowEngine.makeUnsafe(encoded)
```

The layer requires Journal, RunStore, AttemptStore, CacheStore,
DurableEngineState, StepBoundary, Jj, and Scope. EngineStore.make returns the
typed WorkflowEngine service. EngineStore.layer also provides SnapshotBoundary.

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

DurableEngineState.layerMemory is a restartable in-memory store for deferred
completions and absolute clock deadlines. StepBoundary.layerTest() is a
deterministic test boundary. Production activity dispatch is content-keyed for
sealed activities with identity, and ordinal-keyed otherwise. Compensable
activities require SnapshotBoundary; irreversible retries require an activity
idempotency key.

See the [reference](../../docs/reference/engine-store.md) for the exact
contracts, outcomes, persistence order, and explicit exclusions.
