# @smthrs/engine-store

The durable `FlowEngine`. It claims a run before driving it, fences every write against the current owner, and persists attempts, waits, and terminal results through the journal stores.

```ts
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a",
  isAlive: () => Effect.succeed(false)
})
```

This entry point is Node-only: `EngineStore` reads `process.pid` and imports `randomUUID` from `node:crypto`. Those two are the whole browser gap.

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/engine-store` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/engine-store/src/index.ts) | Node |

## EngineStore

[src/EngineStore.ts](https://github.com/smithersai/flows/blob/main/packages/engine-store/src/EngineStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `owner.hostId`, `journalSource`, `isAlive` |
| `make` | constructor | builds the engine from the required services |
| `layer` | layer | the same as a `Layer` |
| `EngineCompositionError` | class | `code: "engine_not_composed"` |

Required services: `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, and a `Scope`.

`isAlive` is application-supplied. Elapsed wall time alone never proves an owner is dead, so takeover consults this probe.

## DurableEngineState

[src/DurableEngineState.ts](https://github.com/smithersai/flows/blob/main/packages/engine-store/src/DurableEngineState.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `DurableEngineState` | service tag | deferreds, clocks, waiting rows, run-parent edges |
| `Service` | interface | the methods below |
| `make`, `layer` | SQL implementation | persists through `Database` |
| `makeMemory`, `layerMemory`, `MemoryOptions`, `MemoryRunView` | memory implementation | deterministic tests |
| `DeferredAddress`, `DeferredRow`, `CompleteDeferredOutcome` | shapes | deferred completions |
| `ClockAddress`, `ClockRow`, `ScheduleClockOutcome`, `CompleteClockOutcome` | shapes | absolute deadlines |
| `Waiting`, `WaitingRow`, `WaitingRunsFilter`, `WaitingReason`, `ParkOutcome`, `WakeOutcome` | shapes | the park and wake taxonomy |
| `RunParentEdge`, `RecordRunParentOutcome`, `RunParentCycleError` | shapes + error | durable lineage and cycle rejection |
| `AttemptSurvivors` | interface | which attempt rows survive a fork or prune |

`recordRunParent` inserts the parent edge and walks the child-to-parent chain inside one write transaction, so a cycle is rejected in storage rather than by an in-process gate.

## StepBoundary

[src/StepBoundary.ts](https://github.com/smithersai/flows/blob/main/packages/engine-store/src/StepBoundary.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `StepBoundary` | service tag | prepare and settle around an activity |
| `Service`, `PreparedBoundary` | interfaces | |
| `FileBoundary`, `FileInput` | schemas + types from `@smthrs/engine` subpaths | the declared filesystem boundary |
| `Activity.BoundaryMode` | schema + type from `@smthrs/engine/Activity` | `hard` or `expected` enforcement |
| `BoundaryEvidence`, `BoundaryDeviation`, `readSetMatches` | schemas + predicate | settle evidence |
| `make` | constructor | from an implementation |
| `makeFileSystem`, `FileSystemOptions`, `layer` | filesystem implementation | measures declared read sets, materializes declared outputs |
| `layerTest`, `TestOptions` | test layer | simplified descriptor for suites |
| `UndeclaredWrite`, `UnsupportedBoundary`, `BoundaryCorruption` | classes | boundary failures |

`layer` cannot observe writes outside the declared sets, so its evidence is deliberately not admitted to the cross-run cache. Whole-tree write verification is Planned.

## Inconsistency

[src/Inconsistency.ts](https://github.com/smithersai/flows/blob/main/packages/engine-store/src/Inconsistency.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Inconsistency` | service tag | receives cache conflicts and blob corruption |
| `Service`, `MakeOptions`, `CacheConflict`, `BlobCorruption` | shapes | |
| `InconsistencyVerdict` | type | what the receiver decides |
| `make`, `makeNoop` | constructors | |
| `layerStrict` | layer | journal the conflict, then fail the run |
| `layerTolerant` | layer | journal the conflict and continue |
| `layerNoop` | layer | |

The unwired core default is strict.

## Errors

[src/Errors.ts](https://github.com/smithersai/flows/blob/main/packages/engine-store/src/Errors.ts)

| Export | `code` |
| --- | --- |
| `FlowCycleDetected` | `flow_cycle_detected` |
| `AttemptAdmissionRejected` | `attempt_admission_rejected` |
| `CacheConflictDetected` | `cache_conflict_detected` |
| `CacheCorruptionDetected` | `cache_corruption_detected` |
| `AttemptEvidenceQuarantined` | `attempt_evidence_quarantined` |

Every `code` literal is part of the public API. Consumers may switch on `code` or `_tag`.
