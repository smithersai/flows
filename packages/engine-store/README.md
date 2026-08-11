# @smthrs/engine-store

Durable persistence adapter for `@smthrs/engine`. It composes journal-backed
run ownership, attempts, cache provenance, deferreds, clocks, and workspace
snapshot boundaries into a `FlowEngine` layer.

```sh
npm install @smthrs/engine-store
```

## Bundles for the browser, runs on SQLite

**This entry point bundles for a browser.** The two host reads it once made
directly — `process.pid` and `randomUUID` from `node:crypto`, used to identify
an owner and stamp attempt nonces — now enter through the injectable
`OwnerIdentity` service, whose default reads a process id off `globalThis`
where one exists and draws an incarnation number from `Random` where none
does (issue #114). The SQL it drives is driver-neutral — `@smthrs/journal`
and `@smthrs/database` both bundle too — but the only `DurableWriter` backing
shipped here is `node:sqlite` through `@effect/sql-sqlite-node`, so a browser
deployment must supply its own SQL client.

`scripts/browser-check.mjs` at the repository root pins that boundary: it
bundles this entry point for the browser and fails the build if it regresses.
See [browser support](../../docs/architecture/browser-support.md).

## Public API

The root exports these namespaces; each is also available from its matching
`@smthrs/engine-store/*` subpath.

| Namespace            | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DurableEngineState` | `DurableEngineState` / `Service` persist deferreds, clocks, and parked-run state through `deferred`, `completeDeferred`, `clock`, `scheduleClock`, `completeClock`, `dueClocks`, `completedDeferreds`, `park`, `wake`, `waiting`, and `waitingRuns`. Address/row types are `DeferredAddress`, `DeferredRow`, `ClockAddress`, `ClockRow`, `Waiting`, `WaitingRow`, and `WaitingRunsFilter`; outcome types are `CompleteDeferredOutcome`, `ScheduleClockOutcome`, `CompleteClockOutcome`, `ParkOutcome`, and `WakeOutcome`; `WaitingReason` is the open wait taxonomy. `make` / `layer` use `DurableWriter`; `makeMemory` / `layerMemory` are deterministic in-memory variants. |
| `EngineStore`        | `Options` configures owner identity, journal source, liveness probing, and the optional `clockFireRetryPolicy` (defaults to exponential from 100ms capped at 30s, forever). `make` builds the service and `layer` provides `FlowEngine` plus `SnapshotBoundary`; `EngineCompositionError` is the stable composition error.                                                                                                                                                                                                                                                                                                                                                    |
| `StepBoundary`       | `PreparedBoundary`, `BoundaryDeviation`, `BoundaryEvidence`, `Service`, and `StepBoundary`; errors `UndeclaredWrite`, `UnsupportedBoundary`, and `BoundaryCorruption`; production and test layers. The shared declaration types `FileBoundary`, `BoundaryMode`, and `FileInput` live in `@smthrs/flow`'s `Activity` namespace.                                                                                                                                                                                                                                                                                                                                                |
| `Inconsistency`      | `Inconsistency` / `Service` receive `CacheConflict` and return `InconsistencyVerdict`. `MakeOptions`, `make`, `makeNoop`, and `layerNoop` build receivers; `layerStrict` journals and returns `"fail"`, while `layerTolerant` journals and returns `"tolerate"`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OwnerIdentity`      | `OwnerIdentity` / `Service` mint the `OwnerId` an incarnation fences its writes with. `make` builds one from an implementation, `makeDefault` / `layer` supply the platform default, and `layerConstant(owner)` pins a fixed identity for a test or a host that already holds a lease.                                                                                                                                                                                                                                                                                                                                                                                        |
| `RunState`           | The versioned run-state envelope schema the engine stores in each run row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Migrations`         | `set` is this package's own `MigrationSet`; `sets` is the composed, dependency-ordered list an engine installs; `run` and `layer` execute it through `@smthrs/database`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Errors`             | Stable `FlowCycleDetected`, `AttemptAdmissionRejected`, and `CacheConflictDetected` errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

```ts
import { EngineStore } from "@smthrs/engine-store"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"

const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store",
  isAlive: (owner) => checkOwner(owner)
})

const program = Effect.gen(function*() {
  return yield* FlowRuntime.FlowRuntime
}).pipe(Effect.provide(engineLayer))
```

`EngineStore.layer` requires `Journal`, `RunStore`, `AttemptStore`, `CacheStore`,
`DurableEngineState`, `StepBoundary`, `Jj`, `OwnerIdentity`, and `Scope`. Run
migrations before using the SQL-backed durable state; provide
`OwnerIdentity.layer` unless the host mints its own owner tokens.

`RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` are the
executable authorities today. Every lifecycle event is written with
`emitDurable` **inside `Journal.transact`**, the write transaction that also
carries the state transition it describes: the attempt row and its
`attemptStarted`/`attemptFinished`, the run-row CAS and its decision, the
deferred/clock row and its record, the cache provenance entry and the cache
row. The stores share one `DurableWriter`, so their writes join that transaction as
savepoints — either both halves are durable or neither is, and audit, sync, and
time travel can no longer read a hole. A crash before the commit loses the
whole unit, so an activity that had already executed re-executes on adoption.
No local WAL makes a remote effect atomic, so external effects still need
idempotency keys, fencing, or compensation.

See the [engine-store reference](../../docs/reference/engine-store.md),
[durable execution model](../../docs/concepts/durable-execution-model.md), and
[step keys](../../docs/concepts/step-keys.md).
