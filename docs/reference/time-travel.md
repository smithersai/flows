# `@smthrs/time-travel`

This page is the public API reference for the `TimeTravel` service and the stores it reads through. The package is a protocol library and is not automatically wired into every engine execution.

## Frames and stores

`Frame.Frame` is the schema for `{ lineageId, seq }`. `LineageEdgeKind` is `child`, `fork`, or `continuation`; `LineageEdge` relates a parent sequence to a child run. Store snapshots associate that frame with a run ID and Jujutsu change ID.

`TimeTravelStore.Service` stores and retrieves:

- snapshots at frames,
- descendants and lineage edges,
- rewind audits and compensation receipts,
- fork records,
- atomic archive/truncation results.

`TimeTravelStore` exports `make`, `makeNoop`, and `layerNoop`. `MemoryTimeTravelStore.make/layer` provides observable memory state. `SqlTimeTravelStore.migrate`, `make`, and `layer` provide SQL persistence over `DurableWriter` and Effect's `SqlClient`.

## Operations

`TimeTravel` is one injectable service with three operations, each addressed by
a `Position` — a run ID plus a `Frame`:

| Operation | Main API |
| --- | --- |
| inspect | `inspect(position, projection)` folds committed journal entries |
| fork | `fork(position, options?)` creates a fork and its derived Jujutsu workspace |
| rewind | `rewind(position, options?)` runs the fenced audit/compensate/restore/archive protocol |

`TimeTravel.layer` requires `TimeTravelStore`, `Journal`, `RunStore`,
`CacheStore`, and `Jj`, and nothing else. Building it completes or rolls back
interrupted rewind audits, so recovery is never a call. `Replay`, `Fork`,
`Rewind`, `Retry`, `Recovery`, `Compensation`, and `EffectHandlerRegistry` are
internal machinery under `src/internal/`.

`ForkOptions` carries only `workspaceRoot`; the workspace name and path are
derived from the position. `RewindOptions` carries `detachedChildren` and
`pageSize`; the owner and audit ID are minted internally. `RewindResult`
returns audit, archive, assessments, warnings, and cancelled children.

Cancelling a detached child under `detachedChildren: "cancel"` is terminal and happens *before* the archive commit point, so it is the one rewind mutation rollback cannot undo. Each cancellation is written to the audit detail as it happens, and a rewind that later rolls back keeps the full `cancelledChildren` list and names the surviving cancellations in `detail.failure`. A `rolled_back` audit therefore never understates what the attempt left behind.

## External-effect records

`EffectBoundary.guard` records an external effect’s intended and terminal status using the journal. `fromEntry` and `fromEntries` decode those records. `eventType` is the stable journal event name.

Handler registration and compensation planning are internal: `rewind` resolves
handlers, classifies each record as `revertible`, `warning`, or `blocking`, and
records the rollback receipts on its audit itself.

## Errors

`TimeTravelError` is the tagged failure type. `TimeTravelErrorCode` is `busy`, `live_parent`, `live_child`, `not_found`, `rate_limited`, `compensation_failed`, `irreversible`, or `unknown`. `error(code, message, cause?)` is the constructor helper.

## Integration caveat

`SqlTimeTravelStore.createFork` creates a restartable engine row, copies
attempts, copies the selected journal prefix, and records lineage twice: in
`flows_time_travel_edges` for the attach/detach protocol, and in the child's
`flows_runs.parent_run_id` so ancestry is walkable with a recursive CTE and
survives edge archival. Current run state and attempts are not historical
per-frame snapshots, so applications must still create boundary records and
snapshots where exact frame semantics require them. Automatic integration is
**Planned**.

See [Time travel](../concepts/time-travel.md), [Failure and retry](../concepts/failure-and-retry.md), and [Implementation status](../architecture/implementation-status.md).
