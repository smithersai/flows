# @smithers/engine-store

Durable persistence adapter for `@smithers/engine`. It composes journal-backed
run ownership, attempts, cache provenance, deferreds, clocks, and workspace
snapshot boundaries into a `FlowEngine` layer.

```sh
npm install @smithers/engine-store
```

## Public API

The root exports these namespaces; each is also available from its matching
`@smithers/engine-store/*` subpath.

| Namespace            | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DurableEngineState` | `DurableEngineState` / `Service` persist deferreds, clocks, and parked-run state through `deferred`, `completeDeferred`, `clock`, `scheduleClock`, `completeClock`, `dueClocks`, `completedDeferreds`, `park`, `wake`, `waiting`, and `waitingRuns`. Address/row types are `DeferredAddress`, `DeferredRow`, `ClockAddress`, `ClockRow`, `Waiting`, `WaitingRow`, and `WaitingRunsFilter`; outcome types are `CompleteDeferredOutcome`, `ScheduleClockOutcome`, `CompleteClockOutcome`, `ParkOutcome`, and `WakeOutcome`; `WaitingReason` is the open wait taxonomy. `make` / `layer` use `Database`; `makeMemory` / `layerMemory` are deterministic in-memory variants. |
| `EngineStore`        | `Options` configures owner identity, journal source, and liveness probing. `make` builds the service and `layer` provides `FlowEngine` plus `SnapshotBoundary`; `EngineCompositionError` is the stable composition error.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `StepBoundary`       | Schemas/types `BoundaryMode`, `ReadSetEntry`, `Descriptor`, `BoundaryDeviation`, and `BoundaryEvidence`; `PreparedBoundary`, `Service`, and `StepBoundary`; errors `UndeclaredWrite` and `UnsupportedBoundary`; `make`, `TestOptions`, and `layerTest`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Inconsistency`      | `Inconsistency` / `Service` receive `CacheConflict` and return `InconsistencyVerdict`. `MakeOptions`, `make`, `makeNoop`, and `layerNoop` build receivers; `layerStrict` journals then fails and `layerTolerant` journals then continues.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Errors`             | Stable `FlowCycleDetected`, `AttemptAdmissionRejected`, and `CacheConflictDetected` errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

```ts
import { FlowEngine } from "@smithers/engine"
import { EngineStore } from "@smithers/engine-store"
import { Effect } from "effect"

const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store"
})

const program = Effect.gen(function*() {
  return yield* FlowEngine.FlowEngine
}).pipe(Effect.provide(engineLayer))
```

`EngineStore.layer` requires `Journal`, `RunStore`, `AttemptStore`, `CacheStore`,
`DurableEngineState`, `StepBoundary`, `Jj`, and `Scope`. Run migrations before
using the SQL-backed durable state.

See the [engine-store reference](../../docs/reference/engine-store.md),
[Run Ownership](../../../docs/specs/Concepts/Run%20Ownership.md),
[Step Keys](../../../docs/specs/Concepts/Step%20Keys.md), and
[Engine Hardening Round 1](../../../docs/specs/Concepts/Engine%20Hardening%20Round%201.md).
