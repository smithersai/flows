# @smthrs/time-travel

Durable replay, fork, rewind, recovery, and compensation primitives over the
journal and engine-store contracts. It owns both in-memory and SQL state stores
and records effect-boundary evidence used to make time-travel decisions.

```sh
npm install @smthrs/time-travel
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/time-travel/*` subpaths.

| Namespace               | Public exports                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Frame`                 | `Frame` schema/type plus `LineageEdgeKind` schema/type and `LineageEdge`.                                                                                                                                                                                                                            |
| `TimeTravelError`       | `TimeTravelErrorCode` schema/type, `TimeTravelError`, and `error(code, message, cause?)`.                                                                                                                                                                                                            |
| `TimeTravelStore`       | Models `Snapshot`, `Descendants`, `Audit`, `Receipt`, `ArchiveResult`, and `Fork`; `Service` / `TimeTravelStore` operations `snapshotAt`, `descendants`, `writeAudit`, `updateAudit`, `pendingAudits`, `archiveAndTruncate`, `createFork`, and `recordReceipt`; `make`, `makeNoop`, and `layerNoop`. |
| `MemoryTimeTravelStore` | `JournalRecord`, `MemoryState`, and `Options`; deterministic `make(options?)` and `layer(options?)`.                                                                                                                                                                                                 |
| `SqlTimeTravelStore`    | Database-backed `migrate`, `make`, and `layer`.                                                                                                                                                                                                                                                      |
| `Replay`                | `Projection`, `ReplayOptions`, and `rederive(frame, projection, options)` replay a journal prefix.                                                                                                                                                                                                   |
| `Fork`                  | `ForkOptions` and `fork(options)` copy a prefix to a child run without mutating the parent.                                                                                                                                                                                                          |
| `Rewind`                | `RewindStep`, `RateLimitDecision`, `DetachedChildPolicy`, `DetachedChildWarning`, `AuditDetail`, `Options`, `Result`, and `rewind(options)`.                                                                                                                                                         |
| `Compensation`          | Planning/result models `Assessment`, `Plan`, `WorkspaceReceipt`, and `Result`; `assess`, `compensate`, `restoreWorkspace`, `execute`, `rollback`, and `toStoreReceipts`.                                                                                                                             |
| `EffectHandlerRegistry` | `Classification`, `Assessment`, `RollbackReceipt`, and `Handler`; `Service` / `EffectHandlerRegistry` expose `handlers`, `register`, `resolve`, `assess`, `revert`, and `rollback`; `make`, `makeNoop`, `layer`, and `layerNoop`.                                                                    |
| `EffectBoundary`        | `EffectTier`, `EffectStatus`, `EffectRecord`, and `Description`; `eventType`; `guard`, `fromEntry`, and `fromEntries`.                                                                                                                                                                               |
| `Recovery`              | `Options`, `Outcome`, and `recover(options)` resume interrupted audits.                                                                                                                                                                                                                              |
| `Retry`                 | `AttemptContext`, `BlockedReason`, `Outcome`, `Options`, and bounded `retry(options)`.                                                                                                                                                                                                               |

```ts
import { MemoryTimeTravelStore, TimeTravelStore } from "@smthrs/time-travel"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const store = yield* TimeTravelStore.TimeTravelStore
  return yield* store.pendingAudits()
}).pipe(Effect.provide(MemoryTimeTravelStore.layer()))
```

See the [time-travel reference](../../docs/reference/time-travel.md) and
[time-travel concepts](../../docs/concepts/time-travel.md).
