# @smthrs/run-store

Durable run state for flows: what is running now, and who owns it. Split out
of `@smthrs/journal` — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

`RunStore` and `AttemptStore` hold the executable state that recovery reads,
as **rebuildable materializations of journal events** — see
[`docs/specs/Concepts/Run State Fold.md`](../../../docs/specs/Concepts/Run%20State%20Fold.md).
Every mutation of run lifecycle state, run waiting payload columns, or an
attempt row appends a journal event describing it in the SAME write
transaction as the row write: both write through the same `DurableWriter` and
join it as savepoints, and an append made inside an enclosing
`Journal.transact` joins that transaction without re-acquiring the journal's
allocation permit. The journal's event history is the durable contract; the
tables exist for fast recovery, and dropping `flows_runs` and `flows_attempts`
and replaying the journal rebuilds equivalent state. The `Fold` namespace
holds the reducers and the rebuild operation, and an event is appended when
and only when the table changed — refused writes (`Conflict`, `FenceLost`,
`NotFound`, `StateChanged`, `GuardFailed`, a repeat cancellation request, or
a wake of a run that was not waiting) append nothing. The contract cuts both
ways: an append the journal refuses fails the row write with it, surfaced as
`persistence_failed` — there is no success path that writes a row without
its event. This package is not the namespace's only appender:
`@smthrs/engine-store`'s `DurableEngineState.park`/`wake` write the
`flows_runs` waiting payload columns and append `flows.run.transitioned`
with a `waiting` payload in the same transaction.

`Ownership` supplies the liveness evidence, probes, timing constants, and
heartbeat supervision for a run's owner. Its public API and rules are
unchanged, but arbitration is delegated to the `Consensus` strategy injected
from `@smthrs/journal` — see
[`docs/specs/Concepts/Journal Consensus.md`](../../../docs/specs/Concepts/Journal%20Consensus.md).
Claims, activation, steals, and fence checks are strategy calls; the
heartbeat supervision loop drives `Consensus.heartbeat` and interrupts the
run owner on fence loss or persistence failure exactly as before.
`RunStore.heartbeat` renews the lease through the strategy, then mirrors the
renewed timestamp onto the `flows_runs` row the caller owns — and the mirror
write is verified: when the strategy renews but no `running` row owned by the
caller matches, the outcome is `FenceLost` (or `NotFound` when the run row is
gone), never a success that wrote nothing. The
CAS-on-`flows_runs` mechanics that used to arbitrate ownership are now the
specification of the default `SqlConsensus` strategy, which keeps them in a
lease table it owns. `RunStore` only _validates_ supplied evidence; it never
probes a process or a network itself.

The SQL layers require `Journal` in context, declared in the layer types:
composing `RunStore.layer`/`layerWith` or `AttemptStore.layer`/`layerWith`
without a journal fails to typecheck, so a missing journal can never
silently skip an append. (The stage 1 behavior — events recorded only when
a journal happened to be present at layer construction — is retired; only
the noop layers compose without one.) `RunStore` appends the
ownership-transition events — claimed, activated, released, stolen,
expired — through the journal (rule R6 of the consensus note), so a
transition and the event describing it commit together. The
`flows.run.transitioned` to `running` appended inside `activate` and
`claimAndOwn` is fenced by the owner the same transaction grants; the
strategy records the grant before the guard runs, so activation never fails
itself with `fence_lost`. The events are ordinary journal entries: their event types live in
the journal's reserved `flows.consensus.*` namespace, and each carries
`meta.lineageId` set to the run's root **journal** lineage (`<runId>/root`,
the lineage-id definition of
[`docs/specs/Concepts/Subflows.md`](../../../docs/specs/Concepts/Subflows.md)
with an empty node path — a transition addresses the run as a whole, not a
node). That is the same lineage meta every other durable append carries, so
lineage folds such as `@smthrs/time-travel`'s rewind and archive boundaries
can place them. It is not the trampoline `lineage_id` column this store
persists, which names a chain of round executions, not a journal position.
The append joins whatever write transaction encloses it: a driver
that wraps an owned transition in `Journal.transact` gets one transaction,
not a nested one, because the R6 append never re-acquires the journal's
allocation permit. Heartbeats are lease evidence, not history, and never
enter the journal.

```sh
pnpm add @smthrs/run-store
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/run-store/*` subpaths.

| Namespace      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore`     | `RunStatus`, `RunStoreErrorCode`, `RunStoreError`, `RunSnapshot`, `RunRow`, `CreateOptions`, and `TransitionGuard`; outcome types `RequestCancelOutcome`, `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, and `TransitionOutcome`; `Service` / `RunStore` for create/get/cancel, claim/activate/recover/steal, heartbeat, and owned transitions; `make`, `makeNoop`, `layerNoop`, and the SQL layers `layer` (defaults to `SqlConsensus`) and `layerWith` (takes the `Consensus` strategy from context).                                                                                                                                                                                                                                              |
| `Ownership`    | `OwnerId` (re-exported from `@smthrs/journal`, which defines it as the fence on durable appends), `LivenessEvidence`, `LivenessProbe`, `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, `heartbeatWriteTolerance`, and `heartbeatLoop`. Arbitration is delegated to `@smthrs/journal`'s injected `Consensus` strategy; the supervision loop drives `Consensus.heartbeat`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `AttemptStore` | `AttemptStoreErrorCode`, `AttemptStoreError`, `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options`, and result types `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult`; `Service` / `AttemptStore` operations `put`, `get`, `heartbeat`, `finish`, and `patch`; `makeWith`, `make`, `makeNoop`, `layerNoop`, `layer`, and `layerWith`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Fold`         | Reducers and rebuild operations for the `flows.run.*` and `flows.attempt.*` journal namespaces. The reducers are journal `Projection`s driven through `Journal.project`; `rebuild` replays entries through the journal's read API — never by selecting from the event table, which is `@smthrs/journal`'s private schema — and truncates and repopulates the fold-owned `flows_runs` and `flows_attempts` columns inside one `DurableWriter` transaction. It never touches `flows_consensus_leases`, because leases remain strategy-private state. Compaction cannot orphan the fold: `SqlJournal.compact` retains fold-namespace history below the checkpoint floor until a `flows.run.snapshot` barrier for the run exists at or after the floor, so a rebuild always finds either the events or the snapshots that seed them. |
| `Migrations`   | `set` (the namespaced migration set for `flows_runs` and `flows_attempts`), `run`, and prerequisite `layer`. This set alone is not enough for the SQL layers: arbitration lives in `@smthrs/journal`'s `flows_consensus_leases` table, so `RunStore.layer` and `layerWith` require the journal's migration set to be installed too. The fold migration backfills existing rows by appending `flows.run.snapshot` and `flows.attempt.snapshot` entries before the new write-through contract takes effect — compose the two sets, as the example below and `@smthrs/engine-store/Migrations` do.                                                                                                                                                                                                                                  |

`RunStore.layer` and `RunStore.layerWith` are built from one constructor: it
uses the `Consensus` service when one is present at layer construction and
otherwise falls back to the default `SqlConsensus` over the same database.
`layerWith` declares the `Consensus` requirement in its type, so composing it
without providing a strategy fails to typecheck; nothing checks at runtime —
the fallback is what answers when no strategy was provided. Use `layerWith`
when the strategy choice matters (for example `Consensus.layerLocal` in the
browser) and `layer` when the SQL default is the point. Both, and both
`AttemptStore` SQL layers, require `Journal` in context; unlike the
`Consensus` fallback there is no journal fallback, because a row write
without its event is a hole in the contract.

The root is written against the driver-neutral `@smthrs/database` contract and
bundles for the browser. The test double binds a Node SQLite database, so it
lives under an explicit subpath:

| Import                                | Public exports                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `@smthrs/run-store/test/TestRunStore` | **Node only.** `layer`, providing migrated in-memory `RunStore` and `AttemptStore`. |

An engine needs this package, `@smthrs/journal`, and `@smthrs/step-cache` over
one database; `@smthrs/engine-store/Migrations` composes all four migration
sets, and `@smthrs/engine-store/test/TestStores` is the in-memory bundle.

```ts
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { SqlJournal } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import { Migrations, RunStore } from "@smthrs/run-store"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const migrations = Layer.effectDiscard(
  DatabaseMigrations.run([JournalMigrations.set, Migrations.set])
)
const journal = SqlJournal.layer({ capacity: 1024, overflow: "reject" })
const runs = RunStore.layer.pipe(
  Layer.provideMerge(journal),
  Layer.provide(Layer.provideMerge(migrations, database))
)

const program = Effect.gen(function*() {
  const store = yield* RunStore.RunStore
  yield* store.create("run-1", "{}")
}).pipe(Effect.provide(runs))
```

See the
[run ownership concept](../../../docs/specs/Concepts/Run%20Ownership.md) and
[journal consensus concept](../../../docs/specs/Concepts/Journal%20Consensus.md).
