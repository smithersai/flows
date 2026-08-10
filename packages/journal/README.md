# @smthrs/journal

Durable event, run-ownership, attempt, and content-cache services for flows.
It owns the SQL schema above `@smthrs/database`, bounded journal admission,
fenced run transitions, and the records consumed by engine-store and sync.

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
npm install @smthrs/journal
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/journal/*` subpaths.

| Namespace        | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JournalEvent`   | Branded schema/types `RunId`, `Seq`, `SourceId`, and `SourceSeq`; input/committed schemas `Input` and `Entry`; deterministic `makeEventId`.                                                                                                                                                                                                                                                                                                                                   |
| `Journal`        | `Journal` / `Service` operations `emitLossy`, `emitDurable`, `transact`, `stream`, `entries`, `changes`, `project`, and `flush`; typed errors, receipts, and read options; constructors and no-op layer.                                                                                                                                                                                                                                                                      |
| `SqlJournal`     | `SqlJournalOptions` and database-backed `layer(options)` with explicit lossy and durable channels.                                                                                                                                                                                                                                                                                                                                                                            |
| `Projection`     | Reproducible `Projection` model and identity constructor `make`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Migrations`     | `run` and prerequisite `layer` install the package schema.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RunStore`       | `RunStatus`, `RunStoreErrorCode`, `RunStoreError`, `RunSnapshot`, `RunRow`, `CreateOptions`, and `TransitionGuard`; outcome types `RequestCancelOutcome`, `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, and `TransitionOutcome`; `Service` / `RunStore` for create/get/cancel, claim/activate/recover/steal, heartbeat, and owned transitions; `make`, `makeNoop`, `layerNoop`, and SQL `layer`. |
| `Ownership`      | `OwnerId`, `LivenessEvidence`, `LivenessProbe`, `heartbeatInterval`, `heartbeatStaleAfter`, and `heartbeatLoop`.                                                                                                                                                                                                                                                                                                                                                              |
| `AttemptStore`   | `AttemptStoreErrorCode`, `AttemptStoreError`, `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options`, and result types `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult`; `Service` / `AttemptStore` operations `put`, `get`, `heartbeat`, `finish`, and `patch`; `makeWith`, `make`, `makeNoop`, `layerNoop`, `layer`, and `layerWith`.                                                                                                              |
| `CacheStore`     | `CacheStoreErrorCode`, `CacheStoreError`, `CacheEntry`, and `PutResult`; `Service` / `CacheStore` operations `get`, `put`, and `evict`; `make`, `makeNoop`, `layerNoop`, and SQL `layer`.                                                                                                                                                                                                                                                                                     |
| `RunCoordinator` | Scoped keyed-drain `RunCoordinator` (`active`, `run`, `wake`, `interrupt`) and `make`.                                                                                                                                                                                                                                                                                                                                                                                        |

The root is written against the driver-neutral `@smthrs/database` contract
and bundles for the browser. The test doubles bind a Node SQLite database, so
they live under explicit subpaths:

| Import                             | Public exports                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/journal/test/TestJournal` | **Node only.** `TestJournalOptions` and `layer(options?)`, providing migrated in-memory Journal, RunStore, AttemptStore, and CacheStore services. |
| `@smthrs/journal/test/Notifying`   | `Order`, `Hook`, `wrap`, and `layer` inject before/after notifications around Effect-valued service operations.                                   |

The single `migrations/0001_initial` module creates the current schema. Normal callers use `Migrations.run` or `Migrations.layer`.

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

`RunStore`, `AttemptStore`, and `CacheStore` (with `DurableEngineState` in
`@smthrs/engine-store`) hold the executable authoritative state today; it is
not derived from journal entries. `transact` is what keeps the two halves
consistent anyway: it runs a state projection and the `emitDurable` calls
describing it in ONE write transaction — the stores write through the same
`Database`, so their writes join it as savepoints — and defers publication
until that transaction commits. Either a transition and its lifecycle entry
are both durable, or neither is. See
[implementation status](../../docs/architecture/implementation-status.md).

See the [journal reference](../../docs/reference/journal.md) and
[journal concepts](../../docs/concepts/journal.md).
