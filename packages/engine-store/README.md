# @smthrs/engine-store

Durable persistence adapter for `@smthrs/engine`. It composes journal-backed
run ownership, attempts, cache provenance, deferreds, clocks, and workspace
snapshot boundaries into a `FlowEngine` layer.

```sh
npm install @smthrs/engine-store
```

## Node only

**This package does not run in a browser, and its entry point does not bundle
for one.** `EngineStore` reads `process.pid` and imports `randomUUID` from
`node:crypto` to identify an owner and stamp attempt nonces; those are the
package's only `node:` imports, and they are the complete browser-gap
inventory for a future browser composition (issue #114). The SQL it drives is
driver-neutral — `@smthrs/journal` and `@smthrs/database` both bundle for
the browser — but the shipped `Database` layer beneath it is `node:sqlite`
through `@effect/sql-sqlite-node`.

`scripts/browser-check.mjs` at the repository root pins that boundary in both
directions: it asserts this entry point still fails to bundle for the browser,
and fails the build if it stops failing without the docs being corrected. See
[browser support](../../docs/architecture/browser-support.md).

## Public API

The root exports these namespaces; each is also available from its matching
`@smthrs/engine-store/*` subpath.

| Namespace            | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DurableEngineState` | `DurableEngineState` / `Service` persist deferreds, clocks, and parked-run state through `deferred`, `completeDeferred`, `clock`, `scheduleClock`, `completeClock`, `dueClocks`, `completedDeferreds`, `park`, `wake`, `waiting`, and `waitingRuns`. Address/row types are `DeferredAddress`, `DeferredRow`, `ClockAddress`, `ClockRow`, `Waiting`, `WaitingRow`, and `WaitingRunsFilter`; outcome types are `CompleteDeferredOutcome`, `ScheduleClockOutcome`, `CompleteClockOutcome`, `ParkOutcome`, and `WakeOutcome`; `WaitingReason` is the open wait taxonomy. `make` / `layer` use `Database`; `makeMemory` / `layerMemory` are deterministic in-memory variants. |
| `EngineStore`        | `Options` configures owner identity, journal source, and liveness probing. `make` builds the service and `layer` provides `FlowEngine` plus `SnapshotBoundary`; `EngineCompositionError` is the stable composition error.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `StepBoundary`       | `PreparedBoundary`, `BoundaryDeviation`, `BoundaryEvidence`, `Service`, and `StepBoundary`; errors `UndeclaredWrite`, `UnsupportedBoundary`, and `BoundaryCorruption`; production and test layers. The shared declaration types `FileBoundary`, `BoundaryMode`, and `FileInput` live in `@smthrs/engine`.                                                                                                                                                                                                                                                                                                                                                                |
| `Inconsistency`      | `Inconsistency` / `Service` receive `CacheConflict` and return `InconsistencyVerdict`. `MakeOptions`, `make`, `makeNoop`, and `layerNoop` build receivers; `layerStrict` journals and returns `"fail"`, while `layerTolerant` journals and returns `"tolerate"`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Errors`             | Stable `FlowCycleDetected`, `AttemptAdmissionRejected`, and `CacheConflictDetected` errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

```ts
import { FlowEngine } from "@smthrs/engine"
import { EngineStore } from "@smthrs/engine-store"
import { Effect } from "effect"

const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store",
  isAlive: (owner) => checkOwner(owner)
})

const program = Effect.gen(function*() {
  return yield* FlowEngine.FlowEngine
}).pipe(Effect.provide(engineLayer))
```

`EngineStore.layer` requires `Journal`, `RunStore`, `AttemptStore`, `CacheStore`,
`DurableEngineState`, `StepBoundary`, `Jj`, and `Scope`. Run migrations before
using the SQL-backed durable state.

`RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` are the
executable authorities today. Every lifecycle event is written with
`emitDurable` **inside `Journal.transact`**, the write transaction that also
carries the state transition it describes: the attempt row and its
`attemptStarted`/`attemptFinished`, the run-row CAS and its decision, the
deferred/clock row and its record, the cache provenance entry and the cache
row. The stores share one `Database`, so their writes join that transaction as
savepoints — either both halves are durable or neither is, and audit, sync, and
time travel can no longer read a hole. A crash before the commit loses the
whole unit, so an activity that had already executed re-executes on adoption.
No local WAL makes a remote effect atomic, so external effects still need
idempotency keys, fencing, or compensation.

See the [engine-store reference](../../docs/reference/engine-store.md),
[durable execution model](../../docs/concepts/durable-execution-model.md), and
[step keys](../../docs/concepts/step-keys.md).
