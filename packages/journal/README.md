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

The root exports JournalEvent, Journal, SqlJournal, Projection, Migrations,
RunStore, Ownership, AttemptStore, CacheStore, RunCoordinator, and TestJournal.
Each service module follows the Effect shape: make where an implementation is
accepted, makeNoop, layerNoop, and production layer where a Database is
required.

See the [reference](../../docs/reference/journal.md) for the complete service
signatures, outcome unions, error codes, and fencing rules.
