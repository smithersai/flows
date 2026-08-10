# @smthrs/time-travel

Frame-addressed history: read-only replay, fork, rewind, compensation, recovery, and tier-aware retry. It reads and writes through public journal, cache, host, and time-travel store contracts.

```ts
import { Frame, Replay } from "@smthrs/time-travel"

const frame: Frame.Frame = { lineageId: "build-42/root", seq: 17 }
const count = yield* Replay.rederive(frame, { initial: 0, reduce: (state) => state + 1 }, { runId: "build-42" })
```

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/time-travel` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/index.ts) | any |

## Frame

[src/Frame.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Frame.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Frame` | schema + type | `lineageId` plus journal `seq` |
| `LineageEdge` | interface | parent, child, and kind |
| `LineageEdgeKind` | const + type | `child`, `fork`, `continuation` |

## TimeTravelStore

[src/TimeTravelStore.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/TimeTravelStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `TimeTravelStore` | service tag | |
| `Service` | interface | snapshots, lineage, audits, receipts, archive |
| `Snapshot`, `Descendants`, `Audit`, `Receipt`, `ArchiveResult`, `Fork` | interfaces | stored shapes |
| `make`, `makeNoop`, `layerNoop` | constructors + layer | |

| Implementation | Source | Notes |
| --- | --- | --- |
| `MemoryTimeTravelStore.make`, `layer`, `MemoryState`, `JournalRecord`, `Options` | [src/MemoryTimeTravelStore.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/MemoryTimeTravelStore.ts) | deterministic tests |
| `SqlTimeTravelStore.migrate`, `make`, `layer` | [src/SqlTimeTravelStore.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/SqlTimeTravelStore.ts) | its own migration, separate from the journal ladder |

`SqlTimeTravelStore.migrate` creates `flows_time_travel_snapshots`, `flows_time_travel_edges`, `flows_time_travel_audits`, `flows_time_travel_receipts`, and `flows_time_travel_archive`.

## Replay

[src/Replay.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Replay.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Projection` | interface | `initial` plus `reduce` |
| `ReplayOptions` | interface | `runId`, optional cache resolution |
| `rederive` | function | folds committed entries up to a frame |

`rederive` is read-only. It never invokes a flow handler or an activity dispatcher, which is what separates it from an engine resume.

## Fork and Rewind

| Export | Source | Notes |
| --- | --- | --- |
| `Fork.fork`, `ForkOptions` | [src/Fork.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Fork.ts) | requires a terminal or inactive parent; adds an isolated jj workspace whose scope finalizer forgets it |
| `Rewind.rewind`, `Options`, `Result` | [src/Rewind.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Rewind.ts) | the fenced, audited suffix-removal protocol |
| `Rewind.RewindStep` | type | the protocol steps an audit records |
| `Rewind.DetachedChildPolicy`, `DetachedChildWarning` | type + interface | `block` or `cancel` |
| `Rewind.RateLimitDecision`, `AuditDetail` | interfaces | audit payloads |

## Effect boundaries and compensation

| Export | Source | Notes |
| --- | --- | --- |
| `EffectBoundary.guard`, `fromEntry`, `fromEntries`, `eventType` | [src/EffectBoundary.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/EffectBoundary.ts) | records intent and outcome around an external effect |
| `EffectBoundary.EffectRecord`, `Description`, `EffectTier`, `EffectStatus` | shapes | `intended`, `succeeded`, `unknown` |
| `EffectHandlerRegistry.EffectHandlerRegistry`, `Service`, `Handler`, `Assessment`, `RollbackReceipt`, `Classification`, `make`, `makeNoop`, `layer`, `layerNoop` | [src/EffectHandlerRegistry.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/EffectHandlerRegistry.ts) | maps effect kinds to assessment and rollback handlers |
| `Compensation.assess`, `compensate`, `execute`, `rollback`, `restoreWorkspace`, `toStoreReceipts` | [src/Compensation.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Compensation.ts) | classifies suffix records, then invokes eligible handlers |
| `Compensation.Assessment`, `Plan`, `Result`, `WorkspaceReceipt` | interfaces | |

## Recovery and Retry

| Export | Source | Notes |
| --- | --- | --- |
| `Recovery.recover`, `Options`, `Outcome` | [src/Recovery.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Recovery.ts) | completes or rolls back interrupted rewind audits at startup |
| `Retry.retry`, `Options`, `Outcome`, `AttemptContext`, `BlockedReason` | [src/Retry.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/Retry.ts) | reattempts historical work while blocking unsafe irreversible retries |

## TimeTravelError

[src/TimeTravelError.ts](https://github.com/smithersai/flows/blob/main/packages/time-travel/src/TimeTravelError.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `TimeTravelError` | class | carries a `TimeTravelErrorCode` |
| `TimeTravelErrorCode` | const + type | code literals |
| `error` | constructor | |

## Integration boundary

The protocols here are Implemented and tested against real stores. What is Planned is automatic population: `EngineStore` does not create every snapshot, lineage edge, or effect-boundary record these protocols consume, so an application wires those records and the time-travel migration itself. `SqlTimeTravelStore.createFork` copies the parent's current persisted snapshot and attempts, which is not a per-frame historical view.
