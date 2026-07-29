# `@flows/time-travel`

This page is the public API reference for journal projection replay, time-travel stores, forks, compensating recovery, and audited rewind. The package is a protocol library and is not automatically wired into every engine execution.

## Frames and stores

`Frame.Frame` is the schema for `{ lineageId, seq }`. `LineageEdgeKind` is `child`, `fork`, or `continuation`; `LineageEdge` relates a parent sequence to a child run. Store snapshots associate that frame with a run ID and Jujutsu change ID.

`TimeTravelStore.Service` stores and retrieves:

- snapshots at frames,
- descendants and lineage edges,
- rewind audits and compensation receipts,
- fork records,
- atomic archive/truncation results.

`TimeTravelStore` exports `make`, `makeNoop`, and `layerNoop`. `MemoryTimeTravelStore.make/layer` provides observable memory state. `SqlTimeTravelStore.migrate`, `make`, and `layer` provide SQL persistence over `Database`.

## Operations

| Namespace | Main API |
| --- | --- |
| `Replay` | `rederive(frame, projection, options)` folds committed journal entries |
| `Fork` | `fork(options)` creates a fork and scoped Jujutsu workspace |
| `Rewind` | `rewind(options)` runs the fenced audit/compensate/restore/archive protocol |
| `Recovery` | `recover(options)` completes or rolls back interrupted rewind audits |
| `Retry` | `retry(options)` applies tier-aware retry safety |

`Rewind.Options` includes target run/frame, owner, audit ID, page size, detached-child policy, rate-limit hook, child-liveness hook, and fault-injection hooks. `Rewind.Result` returns audit, archive, assessments, warnings, and cancelled children.

## External-effect records

`EffectBoundary.guard` records an external effect’s intended and terminal status using the journal. `fromEntry` and `fromEntries` decode those records. `eventType` is the stable journal event name.

`EffectHandlerRegistry` registers handlers by effect kind. Each handler classifies a record as `revertible`, `warning`, or `blocking`, and may return a rollback receipt.

`Compensation` exports `assess`, `compensate`, `restoreWorkspace`, `execute`, `rollback`, and `toStoreReceipts`.

## Errors

`TimeTravelError` is the tagged failure type. `TimeTravelErrorCode` is `busy`, `live_parent`, `live_child`, `not_found`, `rate_limited`, `compensation_failed`, `irreversible`, or `unknown`. `error(code, message, cause?)` is the constructor helper.

## Integration caveat

`SqlTimeTravelStore.createFork` does not create the versioned persisted state expected by `EngineStore`. The application must also create boundary records, snapshots, and lineage where its workflow semantics require them. Automatic integration is **Planned**.

See [Time travel](../concepts/time-travel.md), [Failure and retry](../concepts/failure-and-retry.md), and [Implementation status](../architecture/implementation-status.md).
