# @smthrs/journal

The flows event journal: the immutable history of what happened, and nothing
else. It owns `flows_journal_events` above `@smthrs/database`, bounded journal
admission, the `OwnerId` fence its durable channel accepts, the injectable
`Consensus` strategy that arbitrates that fence, and the records consumed by
engine-store and sync.

Run and attempt state live in [`@smthrs/run-store`](../run-store), sealed step
results in [`@smthrs/step-cache`](../step-cache), and the durable
deferred/clock tables in [`@smthrs/engine-store`](../engine-store) — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).
The journal is the only durable contract and consensus is an injected
strategy — see
[`docs/specs/Concepts/Journal Consensus.md`](../../../docs/specs/Concepts/Journal%20Consensus.md)
for the rules R1–R6 every strategy must implement.

The journal is flows' own **logical (domain) write-ahead log**, intended to
become the authoritative state history.
The SQLite or PostgreSQL WAL beneath it is only the storage durability
substrate and is never consumed as the application event API. Lifecycle
evidence takes `emitDurable`, which commits before it returns, and a durable
boundary must not advance a run or expose its result before that commit.
`emitLossy` is the telemetry channel: bounded, optimistic, lossy by
construction, and never a basis for reconstructing what happened. The
executable state is not derived from the log (see below), but `transact`
commits a transition and its entry together, so the two can never disagree.
Committing locally is not remote atomicity — external effects still need
idempotency keys, fencing tokens, or compensation.

```sh
pnpm add @smthrs/journal
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/journal/*` subpaths.

| Namespace      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JournalEvent` | Branded schema/types `RunId`, `Seq`, `SourceId`, and `SourceSeq`; input/committed schemas `Input` and `Entry`; deterministic `makeEventId`.                                                                                                                                                                                                                                                                                                                                         |
| `Journal`      | `Journal` / `Service` operations `emitLossy`, `emitDurable`, `transact`, `stream`, `entries`, `changes`, `project`, `flush`, `checkpoint`, and `compact`; typed errors, receipts, and read options; constructors and no-op layer.                                                                                                                                                                                                                                                   |
| `SqlJournal`   | `SqlJournalOptions` and database-backed layers with explicit lossy and durable channels: `layer(options)` runs over the default `SqlConsensus` strategy; `layerWith(options)` takes the `Consensus` strategy from context instead.                                                                                                                                                                                                                                                    |
| `Consensus`    | The injectable strategy arbitrating rules R1–R6: `Service` operations `claim`, `activate`, `heartbeat`, `release`, `steal`, `recover`, and `guard`; typed outcomes `Claimed { grantedAtMs }`, `Rejected { reason: RejectionReason }`, `Activated`, `Lost`, `Renewed { heartbeatAtMs }`, and `Recovered`, unioned as `ClaimOutcome`, `ActivateOutcome`, `HeartbeatOutcome`, and `RecoverOutcome`; the `ConsensusError` failure (codes `fence_lost` and `persistence_failed`); the liveness vocabulary `LivenessEvidence`, `sameOwner`, `matchesEvidence`, and the heartbeat timing constants; `make`, `makeNoop`, `layerNoop`, and the browser-safe in-memory `layerLocal` (single process, exact commit-time admission). Defined here for the same reason `OwnerId` is: the journal is what consensus fences. |
| `SqlConsensus` | The default database-backed strategy: `layer` keeps the lease in a table the strategy owns — the owner tuple, the two-phase claim columns, `recoverClaim`, and the generation fence relocated from `flows_runs` — and its `guard` joins the append transaction as a `DurableWriter` savepoint, so commit-time admission (R3) is exact.                                                                                                                                              |
| `Projection`   | Reproducible `Projection` model and identity constructor `make`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Redaction`    | The payload redaction applied to journal entries before they are written.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `OwnerId`      | `OwnerId` — `hostId`, `pid`, `nonce` — the fencing token `emitDurable` accepts. Defined here because the journal is what it fences; `@smthrs/run-store`'s `Ownership` re-exports it alongside the arbitration built on it.                                                                                                                                                                                                                                                          |
| `Migrations`   | `set` (the namespaced migration set for `flows_journal_events`, `flows_journal_checkpoints`, and the `flows_consensus_leases` lease table), `run`, and prerequisite `layer`.                                                                                                                                                                                                                                                                                                        |

The root is written against the driver-neutral `@smthrs/database` contract
and bundles for the browser. The test doubles bind a Node SQLite database, so
they live under explicit subpaths:

| Import                             | Public exports                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/journal/test/TestJournal` | **Node only.** `TestJournalOptions` and `layer(options?)`, providing a migrated in-memory `Journal`. `@smthrs/run-store/test/TestRunStore` and `@smthrs/step-cache/test/TestCacheStore` provide theirs; `@smthrs/engine-store/test/TestStores` provides all four over ONE database. |
| `@smthrs/journal/test/Notifying`   | `Order`, `Hook`, `wrap`, and `layer` inject before/after notifications around Effect-valued service operations.                                                                                                                                                                     |

The `migrations/` modules create this package's tables: `0001_initial` the
event table, `0002_checkpoints` the checkpoint/compaction-floor table, and
`0003_consensus` the `flows_consensus_leases` lease table. `0003_consensus`
relocates arbitration state, so on a database whose `flows_runs` table
predates it, the migration backfills a lease row from each `running` run's
owner and claim columns; a `running` run that still has no lease row is not
abandoned — `steal` and `recover` accept valid liveness evidence against it
instead of rejecting. `Migrations.run` and `Migrations.layer` install this
set alone; an application that also needs run, cache, or engine tables
composes `Migrations.set` with the other packages' sets through
`@smthrs/database`'s `Migrations`, which is what
`@smthrs/engine-store/Migrations` already does. The reverse dependency is new
with the lease table: `@smthrs/run-store`'s SQL layers arbitrate through
`SqlConsensus` by default, so they need this set installed too.

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emitDurable({
    runId: "run-1" as JournalEvent.RunId,
    sourceId: "engine" as JournalEvent.SourceId,
    eventType: "run.created",
    payload: { version: 1 }
  })
}).pipe(Effect.provide(journalLayer))
```

`Seq` is canonical per-run replay order; `SourceSeq` identifies producer
retries. Rejected and dropped admissions may consume either sequence, so gaps
are valid.

`@smthrs/run-store`'s `RunStore` and `AttemptStore` (with `DurableEngineState`
in `@smthrs/engine-store`) hold the executable authoritative state today; it is
not derived from journal entries. `transact` is what keeps the two halves
consistent across the package boundary: it runs a state projection and the
`emitDurable` calls describing it in ONE write transaction — the stores write
through the same `DurableWriter`, so their writes join it as savepoints — and
defers publication until that transaction commits. Either a transition and its
lifecycle entry are both durable, or neither is. See
[implementation status](../../docs/architecture/implementation-status.md).

Fenced admission goes through the injected strategy.
`emitDurable(input, owner)`, `checkpoint`, and `compact` keep their
signatures; their admission check is a `Consensus.guard` call instead of a
hard-wired join on
`flows_runs`, which retires the one SQL-level coupling that outlived the
package split — the journal no longer reads a table `@smthrs/run-store` owns.
A fenced append admitted under a fence must not commit after that fence is
lost (rule R3): `SqlConsensus.guard` joins the append transaction as a
`DurableWriter` savepoint, and `layerLocal` is exact within its single
process. Losing the fence still fails the write: the strategy's `guard` fails
with `ConsensusError` (code `"fence_lost"` — there is no separate outcome
type), and the journal surfaces it under its own `fence_lost` error code with
unchanged semantics.

Ownership transitions — claimed, activated, released, stolen, expired —
append to the journal as events (rule R6) so history explains who drove what.
Recording a transition is safe inside an enclosing `transact`: the R6 append
joins the outer write transaction the way every `transact` emit does —
allocated inside the enclosing critical section, publication parked until
COMMIT — and never re-acquires the journal's allocation permit, so a store
that records transitions while driving a run under `transact` cannot
deadlock. Heartbeats and lease rows are the strategy's private state and
never enter the event history. One shared conformance suite runs the
ownership and
fencing contracts against both `layerLocal` and `SqlConsensus.layer` (the
Bazel `GraphTester` pattern), with clock-driven staleness/steal cases and a
commit-after-fence-loss case pinning R3.

See the [journal reference](../../docs/reference/journal.md) and
[journal concepts](../../docs/concepts/journal.md).
