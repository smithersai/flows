# @smthrs/flow-next

The flow authoring model. It defines typed flows, activities, durable waits
and queues, retry policy, step identity, and the runtime port those APIs are
executed against. `@smthrs/engine-next` implements that port; `@smthrs/engine-store-next`
makes it durable.

```sh
npm install @smthrs/flow-next
```

## Mental model

A `Flow` is the durable program, `Activity` values are its recorded
operations, and a `FlowRuntime` runs them. The remaining primitives let the
program wait without requiring the process to stay alive.

```text
Flow
 ├─ executes Activity values
 ├─ waits on DurableDeferred values
 ├─ sleeps with DurableClock
 └─ delegates work through DurableQueue
             │
             ▼
        FlowRuntime  (the port)
   records, suspends, and resumes
             ▲
             │
   @smthrs/engine-next  (the implementation)
```

| Source               | Role                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Flow/`              | Defines a complete durable program and its execute, poll, interrupt, resume, and rollback lifecycle.                      |
| `Activity/`          | Defines an individual durable operation whose result a runtime records or replays, plus its step identity and boundaries. |
| `FlowRuntime/`       | The execution contract those APIs require, the per-execution state contract, and the cycle failure `execute` can return.  |
| `DurableDeferred.ts` | A persisted promise that a flow can await across process restarts.                                                        |
| `DurableClock.ts`    | A timer that eventually completes a `DurableDeferred`.                                                                    |
| `DurableQueue.ts`    | Sends work to a persisted worker and awaits its result through a `DurableDeferred`.                                       |
| `RetryPolicy.ts`     | Data describing when a runtime should retry a failed activity.                                                            |
| `index.ts`           | Exposes the public namespaces.                                                                                            |

## Usage

An `Activity` carries an implementation, attached separately as a layer. A
`Flow` carries a `body`, and never opaque code.

```ts
import { Activity, Flow, Interpreter } from "@smthrs/flow-next"
import { Effect, Layer, Schema } from "effect"

const Render = Activity.make("render", {
  payload: { name: Schema.String },
  success: Schema.String
})

const Greet = Flow.make("Greet", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ name }) => name,
  body: (payload) => Render.call(payload)
})

const GreetLayer = Layer.mergeAll(
  Render.toLayer(({ name }) => Effect.succeed(`hello ${name}`)),
  Interpreter.layer(Greet)
).pipe(Layer.provideMerge(Activity.layerImplementations))
```

Provide a runtime — `FlowEngine.layerMemory` from `@smthrs/engine-next` in tests, or
the durable engine from `@smthrs/engine-store-next` in production — and execute the
flow.

## Dependency direction

`@smthrs/flow-next` depends on no package that executes flows. `FlowRuntime` is the
seam: authoring APIs are written against the port, and an engine supplies it.
There is deliberately no dependency, type-only or otherwise, from this package
back to `@smthrs/engine-next`.

## Public API

The root exports these namespaces, also available from matching
`@smthrs/flow-next/*` subpaths.

| Namespace         | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Flow`            | `Flow` plus erased/schema helper types `AnyStructSchema`, `Execution`, `Any`, `AnyWithProps`, `PayloadSchema`, `RequirementsClient`, and `RequirementsHandler`; `make`, whose `body` is required; result guard/schema/models `isResult`, `Result`, `ResultEncoded`, `CompleteEncoded`, `CompleteSchema`, `Complete` (including `Complete.Schema`), and `Suspended`; runtime helpers `intoResult`, `wrapActivityResult`, `scope`, `provideScope`, `addFinalizer`, `withRollback`, and `suspend`; annotations `CaptureDefects` and `SuspendOnFailure`; execution identity `ExecutionIdRequired`, `ExecutionIdSource`, `CurrentExecutionIds`, `derived`, and `layerExecutionIds`. A flow value exposes `body`, `call`, `child`, `to`, `execute`, `poll`, `interrupt`, `resume`, `executionId`, annotation methods, and `withRollback`. |
| `Activity`        | `Activity`, `Any`, and `AnyWithProps`; durability `Tier` and `IdempotencyKey`; `make`, `retry`, `idempotencyKey`, and `raceAll`; attempt references `CurrentAttempt` and `CurrentOrdinal`; errors `InfraInterrupt` and `IrreversibleRetryRequiresIdempotencyKey`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DurableDeferred` | `DurableDeferred`, `Any`, and `AnyWithProps`; `make`, `await`, `into`, and `raceAll`; token API `TokenTypeId`, `Token`, `TokenParsed` (`FromString`, `fromString`, `encode`, `asToken`), `token`, `tokenFromExecutionId`, and `tokenFromPayload`; external completion `done`, `succeed`, `fail`, and `failCause`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DurableClock`    | `DurableClock`, `make({ name, duration })`, and threshold-aware `sleep(options)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DurableQueue`    | `TypeId`, `DurableQueue`, `make`, flow-side `process`, worker effect `makeWorker`, and worker `layer` constructor `worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RetryPolicy`     | `RetryPolicy` schema/type, `make`, and `defaultRetryPolicy`; decisions `RetryAfter`, `GiveUp`, `RetryDecision`, `retryAfter`, and `giveUp`; `nextDelay`, `nextDelayEffect`, `errorTag`, `isNonRetryable`, `decide`, and `decideEffect`; `RetryAttemptsExhausted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FlowRuntime`     | The execution contract this package declares: the `FlowRuntime` service, the per-execution `FlowInstance` service, `annotateWaiting` and `WaitingAnnotation`, and the `FlowCycleDetected` failure `execute` can return.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `StepIdentity`    | `allocationScope` and `invocationKey`, the one canonical derivation of ordinal step identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Source layout

### Flow source layout

- `Flow.ts` defines the data structure.
- `make.ts` constructs flows.
- `Runtime.ts` implements lifecycle operations.
- `Result.ts` defines persisted execution results.
- `Annotations.ts` defines execution configuration.
- `ExecutionIdRequired.ts` defines the missing-identity error.
- `ExecutionIds.ts` defines the ambient execution-id source and its default.
- `TypeId.ts` contains the private runtime marker.

### Activity source layout

- `Activity.ts` defines the data structure and schemas.
- `make.ts` constructs executable activities.
- `Context.ts` carries attempt and cache state during execution.
- `retry.ts` retries operations while preserving durable identity.
- `StepIdentity.ts` and `idempotencyKey.ts` derive recorded execution keys.
- `FileInput.ts`, `FileBoundary.ts`, and `BoundaryMode.ts` describe filesystem access.
- `CacheEnvironment.ts` describes runtime facts included in cache identity.
- `raceAll.ts` durably races activities.
- `Errors.ts` defines typed failures.
- `TypeId.ts` contains the private runtime marker.

### Flow — define, handle, run, observe

```ts
import { FlowEngine } from "@smthrs/engine-next"
import { Activity, Flow, Interpreter } from "@smthrs/flow-next"
import { Effect, Layer, Option, Schema } from "effect"

class ReviewFailed extends Schema.TaggedErrorClass<ReviewFailed>()(
  "ReviewFailed",
  { reason: Schema.String }
) {}

// Activity.make: the named atom, declared without code.
const Verdict = Activity.make("review", {
  payload: { pr: Schema.String },
  success: Schema.String,
  error: ReviewFailed
})

// Flow.make: payload fields (or a struct schema), success/error schemas, the
// required pure body, and an optional idempotencyKey for deterministic
// execution IDs.
const Review = Flow.make("Review", {
  payload: { pr: Schema.String },
  success: Schema.String,
  error: ReviewFailed,
  idempotencyKey: ({ pr }) => pr,
  body: (payload) => Verdict.call(payload)
})

// Flow annotations: capture defects in results, or park instead of failing.
const Hardened = Review
  .annotate(Flow.CaptureDefects, true)
  .annotate(Flow.SuspendOnFailure, true)

// Interpreter.layer drives the body; the activity implementations the body
// names attach beside it, over the table they file themselves in.
const ReviewHandler = Layer.mergeAll(
  Verdict.toLayer(({ pr }) => Effect.succeed(`lgtm ${pr}`)),
  Interpreter.layer(Review)
).pipe(Layer.provideMerge(Activity.layerImplementations))

// Run and observe. execute needs an executionId unless the flow declares
// idempotencyKey (Review does, so it may be omitted); discard: true
// returns the execution ID without waiting.
const run = Effect.gen(function*() {
  const executionId = yield* Review.executionId({ pr: "42" })
  const started = yield* Review.execute({ pr: "42" }, { discard: true })
  const result = yield* Review.poll(executionId) // Option<Flow.Result<string, ReviewFailed>>
  if (Option.isSome(result) && Flow.isResult(result.value)) {
    result.value._tag // "Complete" (Flow.Complete) | "Suspended" (Flow.Suspended)
  }
  yield* Review.interrupt(executionId)
  yield* Review.resume(executionId)
  return started
}).pipe(
  Effect.provide(ReviewHandler),
  Effect.provide(FlowEngine.layerMemory)
)
```

Inside a handler, `Flow.scope` / `Flow.provideScope` / `Flow.addFinalizer`
manage the execution-scoped resource scope, `Flow.suspend(instance)` parks
the execution, `Flow.withRollback(effect, rollback)` registers how to undo a
successful effect if the enclosing flow later fails, and `Flow.intoResult` /
`Flow.wrapActivityResult` convert
handler effects to `Flow.Result` values (serialized via `Flow.Result`,
`Flow.ResultEncoded`, `Flow.Complete.Schema`, and `Flow.Suspended`).
Executing without an execution ID or an idempotency key takes identity from
the ambient `Flow.CurrentExecutionIds` source, whose default derives it from
the flow tag and the payload's canonical form; `Flow.layerExecutionIds` replaces
it, and `Flow.ExecutionIdRequired` is the defect raised when no source can name
the invocation.

Registering a behavior under a flow tag is the runtime's own seam and stays
internal to this package: a flow has one behavior and it is the body, so there
is no `toLayer` on a flow to attach a second one with.

### Activity — durable steps, tiers, retries, races

```ts
import { Activity, RetryPolicy } from "@smthrs/flow-next"
import { Effect, Schema } from "effect"

// Tiers: "sealed" (default), "compensable" (requires a
// FlowEngine.SnapshotBoundary in context), "irreversible" (retry requires
// an idempotencyKey, else IrreversibleRetryRequiresIdempotencyKey).
const charge = Activity.make({
  name: "charge",
  success: Schema.String,
  error: Schema.String,
  tier: "irreversible",
  idempotencyKey: "charge:pr-42", // string | object
  retryPolicy: RetryPolicy.defaultRetryPolicy,
  execute: Effect.gen(function*() {
    const attempt = yield* Activity.CurrentAttempt // 1-based retry attempt
    const ordinal = yield* Activity.CurrentOrdinal // run-local step ordinal
    // Activity.idempotencyKey derives a run-local invocation key effectfully:
    const key = yield* Activity.idempotencyKey("charge", { includeAttempt: true })
    return `charged on attempt ${attempt} (step ${ordinal}, key ${key})`
  })
})

// Activity.retry wraps an activity with Effect.retry semantics while
// threading CurrentAttempt/CurrentOrdinal; Activity.raceAll races several
// activities durably. Infrastructure interrupts surface as
// Activity.InfraInterrupt and honor `interruptRetryPolicy`.
const resilient = Activity.retry(charge, { times: 3 })
const fastest = Activity.raceAll("fastest-charge", [charge, resilient])
```

### DurableClock — durable sleep

```ts
import { DurableClock } from "@smthrs/flow-next"

// Short sleeps run in memory; anything past inMemoryThreshold (default
// 60s) schedules a durable clock and suspends the flow.
const wait = DurableClock.sleep({
  name: "cooldown",
  duration: "2 days",
  inMemoryThreshold: "30 seconds"
})

// DurableClock.make builds the clock value directly.
const clock = DurableClock.make({ name: "cooldown", duration: "2 days" })
```

### DurableDeferred — external completion

```ts
import { DurableDeferred } from "@smthrs/flow-next"
import { Effect, Exit, Schema } from "effect"

const Approval = DurableDeferred.make("Approval", {
  success: Schema.Boolean,
  error: Schema.String
})

// Inside the flow: await the deferred (suspends until completed), or run
// an effect "into" it so its exit completes the deferred durably.
const awaitApproval = DurableDeferred.await(Approval)
const computed = DurableDeferred.into(Effect.succeed(true), Approval)
// raceAll races effects durably, persisting the first exit:
const winner = DurableDeferred.raceAll({
  name: "first-answer",
  success: Schema.Boolean,
  error: Schema.String,
  effects: [awaitApproval, computed]
})

// Tokens identify a deferred from outside the flow. Inside a flow:
const tokenInFlow = DurableDeferred.token(Approval)
// Outside, derive it from the flow + executionId or payload:
declare const Review: import("@smthrs/engine-next").Flow.Any
const token = DurableDeferred.tokenFromExecutionId(Approval, {
  flow: Review,
  executionId: "run-17"
})
const tokenFromPayload = DurableDeferred.tokenFromPayload(Approval, {
  flow: Review,
  payload: { pr: "42" }
})
// Tokens round-trip through DurableDeferred.Token /
// DurableDeferred.TokenParsed (fromString / FromString / encode / asToken).

// External completion resumes the suspended flow:
const approve = DurableDeferred.succeed(Approval, { token, value: true })
const reject = DurableDeferred.fail(Approval, { token, error: "denied" })
const settle = DurableDeferred.done(Approval, { token, exit: Exit.succeed(true) })
// DurableDeferred.failCause completes with a full Cause.
```

### DurableQueue — durable work queues

```ts
import { DurableQueue } from "@smthrs/flow-next"
import { Effect, Schema } from "effect"

const Renders = DurableQueue.make({
  name: "Renders",
  payload: { page: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ page }) => page
})

// Flow side: enqueue and durably wait for a worker's answer.
const rendered = DurableQueue.process(Renders, { page: "home" })

// Worker side: DurableQueue.worker returns a Layer (forked, scoped);
// DurableQueue.makeWorker is the underlying worker effect.
const RendersWorker = DurableQueue.worker(
  Renders,
  ({ page }) => Effect.succeed(`<html>${page}</html>`),
  { concurrency: 4 }
)
```

### RetryPolicy — declarative retry decisions

```ts
import { RetryPolicy } from "@smthrs/flow-next"

const policy = RetryPolicy.make({
  initialMs: 100,
  factor: 2,
  maxMs: 10_000,
  maxAttempts: 5,
  jitterRatio: 0.2,
  nonRetryable: ["ReviewFailed"]
})
// RetryPolicy.defaultRetryPolicy: 200ms initial, 1.5x factor, 30s cap.

// Pure decision helpers:
const decision = RetryPolicy.decide(policy, { attempt: 2, error: new Error("x") })
// RetryDecision = RetryAfter | GiveUp; built with retryAfter(ms) / giveUp(reason)
const delay = RetryPolicy.nextDelay(policy, 2) // Option<number>; None = give up
RetryPolicy.errorTag(new Error("x")) // extract an error's tag
RetryPolicy.isNonRetryable(policy, new Error("x"))
// RetryPolicy.decideEffect is the effectful variant; exhausting attempts
// yields RetryPolicy.RetryAttemptsExhausted.
```

See the [engine reference](../../docs/reference/engine.md),
[failure and retry](../../docs/concepts/failure-and-retry.md), and
[step keys](../../docs/concepts/step-keys.md).
