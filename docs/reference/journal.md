# `@flows/journal`

This page is the public API reference for durable events, run ownership, activity attempts, and content-cache rows. The package stores engine facts; workflow orchestration is implemented by `@flows/engine-store`.

## Journal events

`JournalEvent` exports branded `RunId`, `Seq`, `SourceId`, and `SourceSeq` schemas, plus:

- `Input`: producer event with run/source identity, event type, payload, and optional metadata.
- `Entry`: committed input plus canonical sequence, event ID, and timestamp.
- `makeEventId(runId, sourceId, sourceSeq)`: stable producer-idempotency address.

`Journal` exports the service tag and these operations:

| Operation | Result |
| --- | --- |
| `emit(input)` | `Accepted`, `Duplicate`, or `Dropped` receipt |
| `entries({ runId, after?, limit })` | Durable page and `hasMore` |
| `stream({ runId, afterSequence? })` | Replay-then-follow stream |
| `changes` | Scoped subscription to locally committed entries |
| `project(projection, options)` | Stream of accumulated projection states |
| `flush` | Wait until currently accepted queued events commit |

`make`, `makeNoop`, and `layerNoop` construct custom or closed implementations. `JournalError` has stable codes; `OverflowPolicy` is `reject`, `drop-newest`, or `drop-oldest`.

## SQL journal

`SqlJournal.layer(options)` provides the bounded batching implementation over `Database`. Options are `capacity`, `overflow`, and optional `batchSize`. Admission is optimistic: an accepted receipt precedes durability.

### Migrations

`Migrations.run` creates the journal, sequence, run, attempt, cache, and supporting tables. `Migrations.layer` runs it as a layer dependency. Apply it before store construction.

## Run ownership

`RunStore` exports:

- `RunStatus`: `pending`, `running`, `suspended`, `completed`, `failed`, or `cancelled`.
- `RunRow` and `RunSnapshot`.
- fenced `create`, `get`, `claim`, `activate`, `abandonClaim`, `recoverClaim`, `heartbeat`, `transitionOwned`, and `steal`.
- tagged outcome unions for every compare-and-set operation.
- `make`, `layer`, `makeNoop`, and `layerNoop`.

`Ownership.OwnerId` contains `hostId`, `pid`, and `nonce`. `LivenessEvidence` records observer and observation time. `heartbeatLoop`, `heartbeatInterval`, and `heartbeatStaleAfter` support scoped ownership maintenance.

## Attempts and cache

`AttemptStore` addresses rows with `AttemptId`, exposes `put`, `get`, `heartbeat`, and `finish`, and returns explicit fenced outcome unions. Checkpoints are capped at 1 MiB.

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance.

Both stores export SQL `make`/`layer` plus no-op test seams.

## Coordination and tests

`RunCoordinator.make({ drain })` deduplicates in-process work by key and exposes `active`, `run`, `wake`, and `interrupt` around scoped fibers. It is not distributed ownership; use `RunStore` for that.

`Projection.make` is an identity constructor for `{ name, initial, reduce }`. `TestJournal.layer(options?)` composes migrations and all SQL stores over in-memory SQLite.

See [Journal semantics](../concepts/journal.md), [Concurrency](../concepts/concurrency.md), and the [`@flows/engine-store` reference](engine-store.md).
