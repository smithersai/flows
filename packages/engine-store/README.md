# @smthrs/engine-store-next

Durable persistence adapter for `@smthrs/engine-next`. It composes journal-backed
run ownership, attempts, cache provenance, deferreds, clocks, and workspace
snapshot boundaries into a `FlowEngine` layer.

```sh
pnpm add @smthrs/engine-store-next
```

## Bundles for the browser, runs on SQLite

**This entry point bundles for a browser.** The two host reads it once made
directly — `process.pid` and `randomUUID` from `node:crypto`, used to identify
an owner and stamp attempt nonces — now enter through the injectable
`OwnerIdentity` service, whose default reads a process id off `globalThis`
where one exists and draws an incarnation number from `Random` where none
does (issue #114). The SQL it drives is driver-neutral — `@smthrs/journal-next`
and `@smthrs/database-next` both bundle too — but the only `DurableWriter` backing
shipped here is `node:sqlite` through `@effect/sql-sqlite-node`, so a browser
deployment must supply its own SQL client.

`scripts/browser-check.mjs` at the repository root pins that boundary: it
bundles this entry point for the browser and fails the build if it regresses.
See [browser support](../../docs/architecture/browser-support.md).

## Public API

The root exports these namespaces; each is also available from its matching
`@smthrs/engine-store-next/*` subpath.

| Namespace            | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DurableEngineState` | `DurableEngineState` / `Service` persist deferreds, clocks, and parked-run state through `deferred`, `completeDeferred`, `clock`, `scheduleClock`, `completeClock`, `dueClocks`, `completedDeferreds`, `park`, `wake`, `waiting`, and `waitingRuns`. Address/row types are `DeferredAddress`, `DeferredRow`, `ClockAddress`, `ClockRow`, `Waiting`, `WaitingRow`, and `WaitingRunsFilter`; outcome types are `CompleteDeferredOutcome`, `ScheduleClockOutcome`, `CompleteClockOutcome`, `ParkOutcome`, and `WakeOutcome`; `WaitingReason` is the open wait taxonomy. `make` / `layer` use `DurableWriter`; `makeMemory` / `layerMemory` are deterministic in-memory variants. |
| `EngineStore`        | `Options` configures owner identity, journal source, liveness probing, and the optional `clockFireRetryPolicy` (defaults to exponential from 100ms capped at 30s, forever). `make` builds the service and `layer` provides `FlowEngine` plus `SnapshotBoundary`; `EngineCompositionError` is the stable composition error.                                                                                                                                                                                                                                                                                                                                                    |
| `StepBoundary`       | `PreparedBoundary`, `BoundaryDeviation`, `BoundaryEvidence`, `Service`, and `StepBoundary`; errors `UndeclaredWrite`, `UnsupportedBoundary`, and `BoundaryCorruption`; production and test layers. The shared declaration types `FileBoundary`, `BoundaryMode`, and `FileInput` live in `@smthrs/flow-next`'s `Action` namespace.                                                                                                                                                                                                                                                                                                                                             |
| `WorkspaceSandbox`   | The functional workspace transaction. Models `Resource`, `InputObservation`, `OutputObservation`, `Provenance`, `FileChange`, `QueuedEffect`, `WorkflowResult`, `Execution`, `DeclarationViolation`, `CacheDisposition`, `Accepted` / `Invalidated` / `ExecutionResult`, and `Host`; services `Workspace` (the in-transaction filesystem and effect outbox) and `EffectDispatcher`; errors `WorkspaceError` and `MaterializationConflict`; the `violations` accessor; `make` / `layer`, `makeHosted`, `makeMemory` (deterministic, browser-safe), and `makeFileSystem` / `layerFileSystem` / `layerDispatcher`.                                                               |
| `PlanScheduler`      | Drives a persisted `@smthrs/plan-next` `Plan`. `Options` configures the run, the admission caps (`concurrency.steps` / `concurrency.agents`, both defaulting to unbounded and both flooring at one), and the `rebaseLimit`; `make` / `layer` build the `Service` (`record`, `append`, `run`) and `PlanScheduler` is its tag. `NodeExecutor` / `Executor` / `layerExecutor` are the DI seam that turns a `NodeInput` into work, `Outcome` is the four-way evaluation result, `Settlement` and `Report` are what a run reports, `Requirements` is what driving one needs, and `SchedulerError` is the scheduler's own refusal.                                                  |
| `Reconciliation`     | The pluggable seam that answers a `Deviation` or a `Conflict` with a `Verdict` (`Fail` / `Reorder` / `FactorOut`). `Reconciliation` / `Service` are the tag and shape; `make` / `layer` install one; `makeDefault` / `layerDefault` are the deterministic default. It is the first consumer `flows.engine.expected-set-deviation` has had.                                                                                                                                                                                                                                                                                                                                    |
| `Selection`          | The advisory seam that guesses which sink nodes are safe to postpone and which flows a plan is missing — a guess schedules work, it never decides what is cached or correct. `SuspectedEdge`, `BeliefSnapshot`, and the `SelectionVerdict` union (`Admit` / `Defer` / `Propose`) are its schemas; `Selection` / `Service` are the tag and shape; `select` returns one verdict per candidate. `layerNoop` — the default — admits everything, so engine behavior with no `Selection` layer provided is byte-identical to today; `layerHeuristic` is the pure, deterministic glob-match default. `SelectionDebt` lists deferred entries for a later guess-free pass to repay.    |
| `ArtifactGc`         | Explicit mark/sweep garbage collection for the artifact store. `ArtifactGc` / `Service` expose `gc(options)`; `GcOptions` / `GcReport` are its contract; `ArtifactGcPolicy` / `Policy` / `layerPolicy` are the opt-in policy seam (grace bound, pinned digests — configures, never schedules); `defaultGraceMs` is git's two-week prune default; `ArtifactGcError` carries `mark_failed` / `sweep_failed`; `make` / `MakeOptions` / `layer` need `SqlClient` and `@smthrs/artifacts-next`'s `ArtifactSweep`.                                                                                                                                                                  |
| `Inconsistency`      | `Inconsistency` / `Service` receive `CacheConflict` and return `InconsistencyVerdict`. `MakeOptions`, `make`, `makeNoop`, and `layerNoop` build receivers; `layerStrict` journals and returns `"fail"`, while `layerTolerant` journals and returns `"tolerate"`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OwnerIdentity`      | `OwnerIdentity` / `Service` mint the `OwnerId` an incarnation fences its writes with. `make` builds one from an implementation, `makeDefault` / `layer` supply the platform default, and `layerConstant(owner)` pins a fixed identity for a test or a host that already holds a lease.                                                                                                                                                                                                                                                                                                                                                                                        |
| `RunState`           | The versioned run-state envelope schema the engine stores in each run row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Migrations`         | `set` is this package's own `MigrationSet`; `sets` is the composed, dependency-ordered list an engine installs; `run` and `layer` execute it through `@smthrs/database-next`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Errors`             | Stable `FlowCycleDetected`, `AttemptAdmissionRejected`, and `CacheConflictDetected` errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

```ts
import { EngineStore } from "@smthrs/engine-store-next"
import { FlowRuntime } from "@smthrs/flow-next"
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

`WorkspaceSandbox` and `EffectDispatcher` are **optional** and change what a
sealed action is worth. Without a sandbox the body runs against the host
directly and `StepBoundary`'s evidence stays honestly run-local: it can only
re-measure paths it was told about, so it never claims whole-tree write
verification and `ActionPersistence` never publishes it. Compose
`WorkspaceSandbox.layerFileSystem()` and the body runs inside an isolated
workspace instead — seeded with exactly its declared read set, diffed whole at
settlement, copied back as a compare-and-set on every pre-image — and its
result becomes eligible for the shared cross-run cache. `examples/src/durable-layer.ts`
is that composition; `docs/concepts/hosts-and-capabilities.md` explains why the
transaction is not a security boundary.

`RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` are the
executable authorities today. Every lifecycle event is written with
`emitDurable` **inside `Journal.transact`**, the write transaction that also
carries the state transition it describes: the attempt row and its
`attemptStarted`/`attemptFinished`, the run-row CAS and its decision, the
deferred/clock row and its record, the cache provenance entry and the cache
row. The stores share one `DurableWriter`, so their writes join that transaction as
savepoints — either both halves are durable or neither is, and audit, sync, and
time travel can no longer read a hole. A crash before the commit loses the
whole unit, so an action that had already executed re-executes on adoption.
No local WAL makes a remote effect atomic, so external effects still need
idempotency keys, fencing, or compensation.

## Selection

The pluggable seam that turns recorded belief — which changed paths tend to
affect which flows — into scheduling advice for `PlanScheduler`. A guess may
suggest extra work, postpone a low-risk step, or order the queue;
a guess never decides what is cached, correct, or up to date. That split is
structural: `Selection.select` is a pure function of a `BeliefSnapshot` pinned
before planning, and its verdicts never enter a step's key or its cache row.

`layerNoop` is the default. With no `Selection` layer provided — or
`layerNoop` explicitly — every candidate is `Admit`, and engine behavior is
byte-identical to today. This is the hard compatibility bar: installing the
seam changes nothing until a deployment opts a heuristic or model-backed
layer in.

**Verdicts.** `Admit` is the pass-through outcome: the node schedules and
runs exactly as it does without `Selection`. `Defer { edge, likelihood }`
postpones the node to a scheduled guess-free full pass; only sink candidates
(no dependents in the plan) are ever offered a verdict, so a `Defer` for a
non-sink is ignored and journaled as an inconsistency observation rather than
honored. A deferred node settles with a new outcome, `"deferred"` — distinct
from `clean`/`built` and from the existing dependency-failure `"skipped"` — it
writes no step-cache row and is journaled as `flows.engine.selection-deferred`
with the node id, dispatch/plan key, the edge, and the likelihood.
`Propose { flow, edge, confidence }` records a flow no real dependency
reaches, journaled as `flows.engine.selection-proposed`; v1 records and
surfaces proposals, it does not append plan nodes automatically. A run-level
override treats every verdict as `Admit` for one run, journaled the way
`--fresh` bypasses the cache.

**The four laws**, each pinned by a test:

1. Guesses never touch keys or the cache — step keys and cache rows for
   admitted nodes are identical with `layerNoop` and with `layerHeuristic`.
2. `deferred` is never `passed` — a distinct outcome, no cache row, a
   journaled debt.
3. Only sinks are deferrable — a node with dependents is never consulted and
   can never end deferred.
4. Guesses add or postpone, never remove — a node the plan requires executes
   exactly as today, and the override option restores full execution.

**Usage**, composing `layerHeuristic` — pure and deterministic, no IO, no
model calls — with a pinned `BeliefSnapshot`:

```ts
import { Selection } from "@smthrs/engine-store-next"
import * as Effect from "effect/Effect"

const beliefs: Selection.BeliefSnapshot = {
  pinnedAtMs: Date.now(),
  edges: [
    {
      scope: "packages/engine/src/**",
      affects: "update-engine-docs",
      confidence: 0.6,
      validFromMs: Date.now(),
      evidence: ["seeded by hand"]
    }
  ]
}

const program = Effect.gen(function*() {
  const selection = yield* Selection.Selection
  return yield* selection.select({
    changed: ["packages/engine/src/PlanScheduler.ts"],
    sinks: [{ nodeId: "lint-docs" }],
    beliefs,
    policy: { deferBelow: 0.05 }
  })
}).pipe(Effect.provide(Selection.layerHeuristic))
```

`layerHeuristic` glob-matches `changed` against each edge's `scope`; a match
yields `likelihood = edge.confidence`; a sink whose best matching likelihood
falls below `policy.deferBelow` becomes `Defer`; an edge whose `affects`
names a flow the plan does not contain becomes `Propose`; everything else is
`Admit`. A model-backed layer is a different composition — this package has
no model dependency and must not grow one.

**Selection debt.** `SelectionDebt` lists every open deferred entry — node/key,
edge, likelihood, and journal provenance — so a later guess-free run can
execute exactly what was deferred. It is a small projection populated
alongside the `flows.engine.selection-deferred` journal write, the same
idiom `DurableEngineState`'s `waitingRuns` and `dueClocks` already use for
actionable rows, rather than a full journal replay: a recertification pass
needs a bounded query, not a scan.

**Not in v1:** rendering `deferred`/`proposed` rows in a plan card, a
model-backed `Selection` layer, belief training or confidence decay, a
read-set proposer for agent steps, plan-level risk scoring, and
automatically appending a `Propose` verdict as a plan node.

See the [engine-store reference](../../docs/reference/engine-store.md),
[durable execution model](../../docs/concepts/durable-execution-model.md), and
[step keys](../../docs/concepts/step-keys.md).
