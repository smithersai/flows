# @smthrs/journal

The logical write-ahead log: the immutable event history, its projections and redaction, and the `OwnerId` fence its durable channel accepts. Run and attempt state live in [`@smthrs/run-store`](/api/run-store), sealed step results in [`@smthrs/step-cache`](/api/step-cache). The journal writes through the `@smthrs/database` contract, so the package root bundles for the browser.

```ts
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const layer = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provideMerge(Migrations.layer)
)
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/journal` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/index.ts) | any |
| `@smthrs/journal/test/TestJournal` | [src/test/TestJournal.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/test/TestJournal.ts) | Node |
| `@smthrs/journal/test/Notifying` | [src/test/Notifying.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/test/Notifying.ts) | any |

## JournalEvent

[src/JournalEvent.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/JournalEvent.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RunId`, `Seq`, `SourceId`, `SourceSeq` | branded schema + type | the two sequence domains |
| `Input` | class | submitted event: `runId`, `sourceId`, `sourceSeq`, `eventType`, `payload`, `meta` |
| `Entry` | class | committed event: `Input` plus `seq`, `eventId`, `emittedAtMs` |
| `makeEventId` | function | deterministic id from `(runId, sourceId, sourceSeq)` |

## Journal

[src/Journal.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Journal.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Journal` | service tag | `flows/journal/Journal` |
| `Service` | interface | the methods below |
| `make`, `makeNoop` | constructors | |
| `layerNoop` | layer | |
| `JournalError` | class | carries a `JournalErrorCode` |
| `JournalErrorCode` | const + type | includes `queue_overflow`, `idempotency_conflict`, `journal_closed` |
| `OverflowPolicy` | type | `reject`, `drop-newest`, `drop-oldest` |
| `Accepted`, `Duplicate`, `Dropped` | interfaces | receipt variants |
| `EmitReceipt`, `DurableReceipt` | types | receipt unions |
| `StreamOptions`, `EntriesOptions`, `EntriesPage` | interfaces | read arguments and page shape |

| Method | Returns | Behavior |
| --- | --- | --- |
| `emitLossy(input)` | `EmitReceipt` | bounded non-blocking queue; may return `Dropped` |
| `emitDurable(input, owner?)` | `DurableReceipt` | allocates and commits inside the write transaction |
| `transact(effect)` | `A` | runs a state projection and its `emitDurable` calls in one transaction |
| `stream(options)` | `Stream<Entry>` | durable history, then committed changes |
| `entries(options)` | `EntriesPage` | paged read |
| `changes` | `PubSub.Subscription<Entry>` | post-commit publication |
| `project(projection, options)` | `Stream<S>` | folds `stream` through a deterministic reducer |
| `flush` | `void` | barrier for the lossy queue |

## SqlJournal

[src/SqlJournal.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/SqlJournal.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `SqlJournalOptions` | interface | `capacity`, `overflow`, `batchSize`, `sourceEventCache`, `redact` |
| `layer` | layer | scoped writer over `DurableWriter` |
## OwnerId

[src/OwnerId.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/OwnerId.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `OwnerId` | schema + type | `hostId`, `pid`, `nonce` — the fence `emitDurable` accepts; `@smthrs/run-store`'s `Ownership` re-exports it |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_journal_events`, in id block `0` |
| `run` | effect | apply the journal schema |
| `layer` | layer | applies the journal schema at construction |

Every other durable table belongs to the package that reads it. `@smthrs/database`'s `Migrations` composes the sets, and `@smthrs/engine-store/Migrations` is the composed list a durable engine installs.

## Projection, Redaction

| Export | Source | Notes |
| --- | --- | --- |
| `Projection.Projection`, `Projection.make` | [src/Projection.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Projection.ts) | `initial` plus an effectful `reduce` |
| `Redaction.Rule`, `defaultRules`, `placeholder`, `isSensitiveKey`, `Options`, `redact`, `Redactor`, `make`, `redactJsonString`, `makeNoop` | [src/Redaction.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Redaction.ts) | applied at the single `payload`/`meta` encode chokepoint |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestJournal.layer(options?)`, `TestJournal.TestJournalOptions` | [src/test/TestJournal.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/test/TestJournal.ts) | the SQL journal over in-memory SQLite; `@smthrs/engine-store/test/TestStores` bundles all four stores over one database |
| `Notifying.wrap`, `Notifying.layer`, `Notifying.Order`, `Notifying.Hook` | [src/test/Notifying.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/test/Notifying.ts) | interstitial crash and fence-loss injection around any Effect service |
