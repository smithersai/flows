# @smthrs/run-store

Durable run state for flows: what is running now, and who owns it. Split out
of `@smthrs/journal` — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

`RunStore` and `AttemptStore` hold the **executable authoritative state** that
recovery reads. They are not derived from the journal's event history: the
journal is history, audit, replay evidence, and the sync feed, and this package
is the thing a restart rebuilds from. `Journal.transact` is what keeps the two
halves consistent — it runs a state projection here and the `emitDurable` calls
describing it in ONE write transaction, because both write through the same
`DurableWriter` and so join it as savepoints.

`Ownership` supplies the liveness evidence, probes, timing constants, and
heartbeat supervision for a run's owner. Its public API and rules are
unchanged, but arbitration is delegated to the `Consensus` strategy injected
from `@smthrs/journal` — see
[`docs/specs/Concepts/Journal Consensus.md`](../../../docs/specs/Concepts/Journal%20Consensus.md).
Claims, activation, steals, and fence checks are strategy calls; the
heartbeat supervision loop drives `Consensus.heartbeat` and interrupts the
run owner on fence loss or persistence failure exactly as before. The
CAS-on-`flows_runs` mechanics that used to arbitrate ownership are now the
specification of the default `SqlConsensus` strategy, which keeps them in a
lease table it owns. `RunStore` only _validates_ supplied evidence; it never
probes a process or a network itself.

With a `Journal` in context, `RunStore` appends the ownership-transition
events — claimed, activated, released, stolen, expired — through it (rule R6
of the consensus note), so a transition and the event describing it commit
together. The append joins whatever write transaction encloses it: a driver
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

| Namespace      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore`     | `RunStatus`, `RunStoreErrorCode`, `RunStoreError`, `RunSnapshot`, `RunRow`, `CreateOptions`, and `TransitionGuard`; outcome types `RequestCancelOutcome`, `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, and `TransitionOutcome`; `Service` / `RunStore` for create/get/cancel, claim/activate/recover/steal, heartbeat, and owned transitions; `make`, `makeNoop`, `layerNoop`, and the SQL layers `layer` (defaults to `SqlConsensus`) and `layerWith` (takes the `Consensus` strategy from context). |
| `Ownership`    | `OwnerId` (re-exported from `@smthrs/journal`, which defines it as the fence on durable appends), `LivenessEvidence`, `LivenessProbe`, `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, `heartbeatWriteTolerance`, and `heartbeatLoop`. Arbitration is delegated to `@smthrs/journal`'s injected `Consensus` strategy; the supervision loop drives `Consensus.heartbeat`.                                                                                                                                                                                      |
| `AttemptStore` | `AttemptStoreErrorCode`, `AttemptStoreError`, `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options`, and result types `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult`; `Service` / `AttemptStore` operations `put`, `get`, `heartbeat`, `finish`, and `patch`; `makeWith`, `make`, `makeNoop`, `layerNoop`, `layer`, and `layerWith`.                                                                                                                                                                                                                    |
| `Migrations`   | `set` (the namespaced migration set for `flows_runs` and `flows_attempts`), `run`, and prerequisite `layer`. This set alone is not enough for the SQL layers: arbitration lives in `@smthrs/journal`'s `flows_consensus_leases` table, so `RunStore.layer` and `layerWith` require the journal's migration set to be installed too — compose the two sets, as the example below and `@smthrs/engine-store/Migrations` do.                                                                                                                                                           |

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
import * as JournalMigrations from "@smthrs/journal/Migrations"
import { Migrations, RunStore } from "@smthrs/run-store"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const migrations = Layer.effectDiscard(
  DatabaseMigrations.run([JournalMigrations.set, Migrations.set])
)
const runs = RunStore.layer.pipe(
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
