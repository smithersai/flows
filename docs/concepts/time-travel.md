# Time travel

This page explains the snapshot, fork, replay, compensation, recovery, and rewind primitives in `@flows/time-travel`. It also identifies the integration work the durable engine does not yet perform automatically.

## Frames and snapshots

A `Frame` identifies a durable point by lineage and journal sequence:

```ts
import { Frame } from "@flows/time-travel"

const frame: Frame.Frame = {
  lineageId: "build-42/root",
  seq: 17
}
```

`TimeTravelStore` stores frame snapshots, run lineage, audits, compensation receipts, and archive metadata. Both memory and SQL implementations exist.

## Projection replay

`Replay.rederive` folds journal entries through a caller-provided projection. This reconstructs derived state; it does not execute a workflow handler:

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

Use workflow replay when the goal is to resume computation. Use projection replay when the goal is to derive a view from committed events.

## Fork

`Fork.fork` requires a terminal or inactive parent run, creates a store-level fork, and asks `Jj` to add an isolated workspace. Its scope finalizer forgets that workspace.

The SQL store currently inserts a fork run with an empty state object. That row is not by itself a runnable `@flows/engine-store` execution because the engine expects its versioned persisted-state envelope. Direct engine execution of a fork is therefore **Planned integration**, not a current end-to-end feature.

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

See [Determinism and replay](determinism-and-replay.md), [Subworkflows](subworkflows.md), and the [`@flows/time-travel` reference](../reference/time-travel.md).
