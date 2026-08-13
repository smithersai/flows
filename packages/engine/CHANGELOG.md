# @smthrs/engine-next

## [Unreleased]

### Breaking Changes

- Split the flow authoring model out into `@smthrs/flow-next`. `Flow`, `Activity`,
  `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, and
  `StepIdentity` are no longer exported here; import them from `@smthrs/flow-next`.
- The `FlowEngine.FlowEngine` service and `FlowEngine.FlowInstance` moved to
  `@smthrs/flow-next` as `FlowRuntime.FlowRuntime` and `FlowRuntime.FlowInstance`,
  together with `annotateWaiting`, `WaitingAnnotation`, and
  `FlowCycleDetected`. `@smthrs/engine-next` implements that port; the dependency
  direction is now `@smthrs/flow-next` ← `@smthrs/engine-next`, with no cycle.
- `FlowEngine.FlowInstance.initial(flow, executionId)` is now
  `FlowEngine.makeInstance(flow, executionId)`.

### Changed

- Broke the single `FlowEngine.ts` module into a `FlowEngine/` folder:
  `Encoded.ts`, `SnapshotBoundary.ts`, `FlowInstance.ts`, `ActivityKey.ts`,
  `make.ts`, `layerMemory.ts`, and the barrel.

- Renamed `Flow.withCompensation` to the clearer `Flow.withRollback`.
- Moved `BoundaryMode` beside the `Activity` model it configures.
- Split the `Flow` module into focused definition, result, runtime, annotation,
  constructor, and error files without changing the `@smthrs/engine-next/Flow`
  import.
- Split `Activity` and its identity, boundary, retry, context, constructor, and
  error code into focused files without changing its public import paths.

### Fixed

- Scoped sealed activity keys to one run until the composition declares its
  complete layer and capability identity.

## [0.1.0] - 2026-08-05

### Added

- Added the vendored durable flow engine with caller-selected execution
  identity, caller-computed activity keys, explicit infrastructure-interrupt
  retry, durability tiers, snapshot boundaries, and signal-assisted resume.

### Fixed

- Kept coverage thresholds on the explicit coverage command so ordinary
  `vitest run` remains the package test gate.
