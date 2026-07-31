# Time travel

This page explains the snapshot, fork, replay, compensation, recovery, and rewind primitives in `@smithers/time-travel`. It also identifies the integration work the durable engine does not yet perform automatically.

## Frames and snapshots

A `Frame` identifies a durable point by lineage and journal sequence:

```ts
import { Frame } from "@smithers/time-travel"

const frame: Frame.Frame = {
  lineageId: "build-42/root",
  seq: 17
}
```

`TimeTravelStore` stores frame snapshots, run lineage, audits, compensation receipts, and archive metadata. Both memory and SQL implementations exist.

## Projection replay

`Replay.rederive` folds journal entries through a caller-provided projection. This reconstructs derived state; it does not execute a flow handler:

```ts
const count = yield* Replay.rederive(
  frame,
  {
    initial: 0,
    reduce: (state) => state + 1
  },
  { runId: "build-42" }
)
```

Use flow replay when the goal is to resume computation. Use projection replay when the goal is to derive a view from committed events.

## Fork

`Fork.fork` requires a terminal or inactive parent run, creates a store-level fork, and asks `Jj` to add an isolated workspace. Its scope finalizer forgets that workspace.

The SQL store copies the parent's versioned engine state without terminal
result or cancellation fields and clones its attempt rows. The fork can
therefore be claimed and driven after engine layers restart. The existing
`flows_time_travel_edges` row remains the lineage source of truth.

Run state and attempts are not currently versioned by journal frame. A fork
uses the parent's current persisted snapshot and attempts; automatic
frame-addressed engine snapshots remain planned integration.

## Effect boundaries and compensation

`EffectBoundary.guard` records intent and outcome around an external effect. Records classify the effect as `sealed`, `compensable`, or `irreversible`, and track `intended`, `succeeded`, or `unknown` status.

`EffectHandlerRegistry` maps effect kinds to assessment and rollback handlers. `Compensation.assess` classifies suffix records; `Compensation.compensate` invokes eligible handlers and returns receipts. Unknown or irreversible effects can block recovery.

## Rewind protocol

`Rewind.rewind`:

1. claims and activates an inactive pending or suspended run,
2. records an audit and rate-limit decision,
3. loads journal entries after the target frame,
4. checks descendant lineage,
5. assesses and compensates external effects,
6. restores the Jujutsu workspace,
7. archives and truncates the suffix atomically,
8. records completion or a recoverable failure.

Detached child policy is either `block` or `cancel`. Terminal descendants are disclosed as warnings because their external effects cannot be erased by deleting a parent suffix.

## Current integration boundary

The time-travel package is implemented and tested as a protocol library, but `EngineStore` does not automatically create every snapshot, lineage edge, or effect-boundary record it consumes. Applications must wire those records and migrations explicitly. Automatic end-to-end integration is **Planned**.

See [Determinism and replay](determinism-and-replay.md), [Subflows](subflows.md), and the [`@smithers/time-travel` reference](../reference/time-travel.md).
