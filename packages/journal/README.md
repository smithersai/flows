# @smithers/journal

@smithers/journal owns durable event envelopes, run ownership, step attempts, and
content-addressed cache entries. It depends on the Database service. Journal
admission is bounded and non-blocking; ownership and durable stores use fenced
SQL transitions.

```text
NodeDatabase.layer({ filename })
  └─ Migrations.layer
       ├─ SqlJournal.layer({ capacity, overflow, batchSize? })
       ├─ RunStore.layer
       ├─ AttemptStore.layer
       └─ CacheStore.layer

TestJournal.layer(options?) supplies the same services over :memory: SQLite.
```

The event envelope has two sequence domains. Seq is the canonical per-run
replay order. SourceSeq is allocated per run and source and makes producer
retries idempotent. Rejected or dropped admissions consume their allocated
numbers; replay must not assume contiguous sequences.

```ts
import { NodeDatabase } from "@smithers/database"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smithers/journal"
import { Effect, Layer } from "effect"

const journalLayer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, NodeDatabase.layer({ filename: "flows.db" })))
)

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  return yield* journal.emit({
    runId: "run-1" as JournalEvent.RunId,
    sourceId: "engine" as JournalEvent.SourceId,
    eventType: "run.created",
    payload: { version: 1 }
  })
})

Effect.runPromise(Effect.provide(program, journalLayer))
```

## Sequence allocation: memory or SQL

`SqlJournalOptions.allocation` chooses where the canonical seq is assigned.
`"memory"` (the default) allocates in process and queues the write, so the
receipt is optimistic and one process must own the run. `"sql"` makes `emit`
an alias for `emitDurable`.

`emitDurable` allocates seq and sourceSeq as MAX + 1 inside the writer's
transaction, using the in-memory clock as a floor, and inserts the row before
returning, so its receipt is already committed. It is the path for
cross-process supervisors, cold restarts, and time-travel forks: any number of
writers may share one run. Deduplication is unchanged — an exact producer
retry returns Duplicate, and a reused producer sequence with different content
fails with idempotency_conflict.

Deviation from smithers, which allocates under BEGIN IMMEDIATE: the SQLite
backends here expose no beginTransaction hook, so the transaction is DEFERRED
and a racing writer loses the lock upgrade with SQLITE_BUSY_SNAPSHOT, which
@smithers/database classifies as retryable and replays whole. Allocation is
conflict-free by retry rather than by lock escalation.

## Run metadata, guards, and cancellation

Migration 0003 adds two columns to flows_runs. `cancel_requested_at_ms` is
stamped by the unfenced `RunStore.requestCancel`, whose outcomes are
CancelRequested, AlreadyRequested (reporting the original request time), and
NotFound. `parent_run_id` records fork lineage for @smithers/time-travel.

Every owned transition accepts an optional `TransitionGuard`, an extra CAS
predicate over that metadata: `{ cancelRequested: "absent" | "present" }`. A
guard that does not hold returns the distinct GuardFailed outcome, which is
deliberately not FenceLost — losing ownership and losing a lifecycle race are
different failures.

## Attempt policy

`AttemptStore.Options` makes previously hard-coded policy explicit, with the
old values as defaults: `inProgressStates` (states that count as in progress
for the heartbeat and finish fences, default `["running"]`),
`maxCheckpointBytes` (default 1 MiB), and `putMode` (`"insert"`
first-writer-wins, reporting Conflict, or `"upsert"`, reporting Upserted).
`AttemptStore.patch` rewrites opaque fields — checkpoint, error, outcome, meta
— outside the ownership fence, and never moves state, started_at_ms, or
finished_at_ms.

The root exports JournalEvent, Journal, SqlJournal, Projection, Migrations,
RunStore, Ownership, AttemptStore, CacheStore, RunCoordinator, and TestJournal.
Each service module follows the Effect shape: make where an implementation is
accepted, makeNoop, layerNoop, and production layer where a Database is
required.

See the [reference](../../docs/reference/journal.md) for the complete service
signatures, outcome unions, error codes, and fencing rules.
