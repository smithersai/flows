# @smithers/journal

Durable event, run-ownership, attempt, and content-cache services for flows.
It owns the SQL schema above `@smithers/database`, bounded journal admission,
fenced run transitions, and the records consumed by engine-store and sync.

```sh
npm install @smithers/journal
```

## Public API

The root exports these namespaces, also available from matching
`@smithers/journal/*` subpaths.

| Namespace        | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JournalEvent`   | Branded schema/types `RunId`, `Seq`, `SourceId`, and `SourceSeq`; input/committed schemas `Input` and `Entry`; deterministic `makeEventId`.                                                                                                                                                                                                                                                                                                                                   |
| `Journal`        | `Journal` / `Service` operations `emit`, `emitLossy`, `emitDurable`, `stream`, `entries`, `changes`, `project`, and `flush`; `JournalErrorCode` / `JournalError`; `OverflowPolicy`; receipts `Accepted`, `Duplicate`, `Dropped`, `EmitReceipt`, and `DurableReceipt`; `StreamOptions`, `EntriesOptions`, and `EntriesPage`; `make`, `makeNoop`, and `layerNoop`.                                                                                                              |
| `SqlJournal`     | `SqlJournalOptions` and database-backed `layer(options)`. `allocation` selects in-memory or transactional SQL sequence allocation.                                                                                                                                                                                                                                                                                                                                            |
| `Projection`     | Reproducible `Projection` model and identity constructor `make`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Migrations`     | `run` and prerequisite `layer` install the package schema.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RunStore`       | `RunStatus`, `RunStoreErrorCode`, `RunStoreError`, `RunSnapshot`, `RunRow`, `CreateOptions`, and `TransitionGuard`; outcome types `RequestCancelOutcome`, `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, and `TransitionOutcome`; `Service` / `RunStore` for create/get/cancel, claim/activate/recover/steal, heartbeat, and owned transitions; `make`, `makeNoop`, `layerNoop`, and SQL `layer`. |
| `Ownership`      | `OwnerId`, `LivenessEvidence`, `LivenessProbe`, `heartbeatInterval`, `heartbeatStaleAfter`, and `heartbeatLoop`.                                                                                                                                                                                                                                                                                                                                                              |
| `AttemptStore`   | `AttemptStoreErrorCode`, `AttemptStoreError`, `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options`, and result types `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult`; `Service` / `AttemptStore` operations `put`, `get`, `heartbeat`, `finish`, and `patch`; `makeWith`, `make`, `makeNoop`, `layerNoop`, `layer`, and `layerWith`.                                                                                                              |
| `CacheStore`     | `CacheStoreErrorCode`, `CacheStoreError`, `CacheEntry`, and `PutResult`; `Service` / `CacheStore` operations `get`, `put`, and `evict`; `make`, `makeNoop`, `layerNoop`, and SQL `layer`.                                                                                                                                                                                                                                                                                     |
| `RunCoordinator` | Scoped keyed-drain `RunCoordinator` (`active`, `run`, `wake`, `interrupt`) and `make`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `TestJournal`    | `TestJournalOptions` and `layer(options?)`, providing migrated in-memory Journal, RunStore, AttemptStore, and CacheStore services.                                                                                                                                                                                                                                                                                                                                            |
| `Notifying`      | `Order`, `Hook`, `wrap`, and `layer` inject before/after notifications around Effect-valued service operations.                                                                                                                                                                                                                                                                                                                                                               |

The public `migrations/0001_initial`, `0002_durable_engine_state`,
`0003_run_metadata`, and `0004_waiting_reason` subpaths each default-export
their migration Effect; normal callers should use `Migrations.run` or
`Migrations.layer`.

```ts
import { NodeDatabase } from "@smithers/database"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smithers/journal"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emit({
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

See the [journal reference](../../docs/reference/journal.md),
[Journal Queue](../../../docs/specs/Concepts/Journal%20Queue.md), and
[Run Ownership](../../../docs/specs/Concepts/Run%20Ownership.md).
