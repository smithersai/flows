# @smthrs/journal

The logical write-ahead log plus the run, attempt, and cache stores that hold executable state. Every store writes through the `@smthrs/database` contract, so the package root bundles for the browser.

```ts
import { Journal, JournalEvent, Migrations, RunStore, SqlJournal } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(Layer.provideMerge(Migrations.layer))
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
| `layer` | layer | scoped writer over `Database` |

## RunStore

[src/RunStore.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/RunStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RunStore` | service tag | `flows/journal/RunStore` |
| `RunStatus` | const + type | `pending`, `running`, `suspended`, `completed`, `failed`, `cancelled` |
| `RunRow`, `RunSnapshot`, `CreateOptions`, `TransitionGuard` | interfaces | row and argument shapes |
| `RunStoreError`, `RunStoreErrorCode` | class + codes | |
| `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, `TransitionOutcome`, `RequestCancelOutcome` | types | compare-and-swap results |
| `make`, `makeNoop` | constructors | |
| `layer`, `layerNoop` | layers | |

| Method | Behavior |
| --- | --- |
| `create(runId, stateJson, options?)` | inserts a `pending` row |
| `get(runId)` | reads the exact row |
| `requestCancel(runId, nowMs)` | records an unfenced cancellation request |
| `claim(runId, expected, claimant, nowMs)` | compare-and-swap on an exact snapshot |
| `claimAndOwn(runId, expected, owner, nowMs, evidence?)` | claim plus activate in one step |
| `activate(runId, claimant, claimedAtMs, expected)` | promotes a claim to ownership |
| `abandonClaim`, `recoverClaim` | generation-fenced claim release and stale-claim recovery |
| `heartbeat(runId, owner, nowMs)` | refreshes the owner fence |
| `transitionOwned(runId, owner, toStatus, stateJson?, guard?)` | owned status change |
| `steal(runId, expected, claimant, nowMs, evidence)` | takeover with liveness evidence |

## Ownership

[src/Ownership.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Ownership.ts)

| Export | Kind | Value |
| --- | --- | --- |
| `OwnerId` | schema + type | `hostId`, `pid`, `nonce` |
| `LivenessEvidence` | schema + type | application-supplied proof an owner is gone |
| `LivenessProbe` | type | probe signature |
| `heartbeatInterval` | `Duration` | 1 second |
| `heartbeatWriteTolerance` | `Duration` | 19 seconds |
| `heartbeatStaleAfter` | `Duration` | 30 seconds |
| `heartbeatSkewAllowance` | `Duration` | clock-skew slack |
| `heartbeatLoop` | function | the owner heartbeat fiber |

## AttemptStore

[src/AttemptStore.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/AttemptStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `AttemptStore` | service tag | address is `(runId, stepKeyDigest, attempt)` |
| `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options` | interfaces | row and argument shapes |
| `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult` | types | fenced outcomes |
| `AttemptStoreError`, `AttemptStoreErrorCode` | class + codes | |
| `make`, `makeWith`, `makeNoop` | constructors | `makeWith` takes an in-progress vocabulary and checkpoint cap |
| `layer`, `layerWith`, `layerNoop` | layers | |

## CacheStore

[src/CacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/CacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `CacheStore` | service tag | digest to result, first writer wins |
| `CacheEntry` | interface | `resultJson`, `metaJson`, `createdAtMs`, `recordedRunId`, `recordedEventSeq` |
| `PutResult` | type | `Inserted`, `ExistingSame`, `Conflict` |
| `EvictOptions` | type | eviction arguments |
| `CacheStoreError`, `CacheStoreErrorCode` | class + codes | |
| `make`, `makeNoop` | constructors | |
| `layer`, `layerNoop` | layers | |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `run` | effect | apply the authoritative schema |
| `layer` | layer | applies the schema at construction |

## Projection, Redaction, RunCoordinator

| Export | Source | Notes |
| --- | --- | --- |
| `Projection.Projection`, `Projection.make` | [src/Projection.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Projection.ts) | `initial` plus an effectful `reduce` |
| `Redaction.Rule`, `defaultRules`, `placeholder`, `isSensitiveKey`, `Options`, `redact`, `Redactor`, `make`, `redactJsonString`, `makeNoop` | [src/Redaction.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/Redaction.ts) | applied at the single `payload`/`meta` encode chokepoint |
| `RunCoordinator.RunCoordinator`, `RunCoordinator.make` | [src/RunCoordinator.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/RunCoordinator.ts) | one keyed drain per execution id in a process |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestJournal.layer(options?)`, `TestJournal.TestJournalOptions` | [src/test/TestJournal.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/test/TestJournal.ts) | journal, run, attempt, and cache stores over in-memory SQLite |
| `Notifying.wrap`, `Notifying.layer`, `Notifying.Order`, `Notifying.Hook` | [src/test/Notifying.ts](https://github.com/smithersai/flows/blob/main/packages/journal/src/test/Notifying.ts) | interstitial crash and fence-loss injection around any Effect service |
