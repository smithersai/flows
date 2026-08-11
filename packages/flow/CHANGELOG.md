# @smthrs/flow

## [Unreleased]

### Added

- Added `@smthrs/flow`, the flow authoring model split out of
  `@smthrs/engine`: `Flow`, `Activity`, `RetryPolicy`, `DurableDeferred`,
  `DurableClock`, `DurableQueue`, `StepIdentity`, and their schemas, errors,
  results, boundaries, and combinators.
- Added `FlowRuntime`, the execution contract those APIs are written against.
  It replaces the direct dependency the authoring modules had on the engine's
  `FlowEngine` module, so the dependency now runs `@smthrs/flow` ←
  `@smthrs/engine` only. The service formerly exported as
  `FlowEngine.FlowEngine` is `FlowRuntime.FlowRuntime`, `FlowEngine.FlowInstance`
  is `FlowRuntime.FlowInstance`, and `FlowEngine.annotateWaiting` and
  `FlowEngine.FlowCycleDetected` moved with them.
