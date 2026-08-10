# @smthrs/engine

Flows fork of Effect's unstable workflow API. It defines typed flows,
activities, durable waits/queues, transport projections, and the low-level
engine contract; `@smthrs/engine-store` supplies durable persistence.

```sh
npm install @smthrs/engine
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/engine/*` subpaths.

| Namespace         | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Flow`            | `Flow` plus erased/schema helper types `AnyStructSchema`, `Execution`, `Any`, `AnyWithProps`, `PayloadSchema`, `RequirementsClient`, and `RequirementsHandler`; `make`; result guard/schema/models `isResult`, `Result`, `ResultEncoded`, `CompleteEncoded`, `CompleteSchema`, `Complete` (including `Complete.Schema`), and `Suspended`; runtime helpers `intoResult`, `wrapActivityResult`, `scope`, `provideScope`, `addFinalizer`, `withCompensation`, and `suspend`; annotations `CaptureDefects` and `SuspendOnFailure`; `ExecutionIdRequired`. A flow value exposes `execute`, `poll`, `interrupt`, `resume`, `executionId`, `toLayer`, annotation methods, and `withCompensation`. |
| `Activity`        | `Activity`, `Any`, and `AnyWithProps`; durability `Tier` and `IdempotencyKey`; `make`, `retry`, `idempotencyKey`, and `raceAll`; attempt references `CurrentAttempt` and `CurrentOrdinal`; errors `InfraInterrupt` and `IrreversibleRetryRequiresIdempotencyKey`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DurableDeferred` | `DurableDeferred`, `Any`, and `AnyWithProps`; `make`, `await`, `into`, and `raceAll`; token API `TokenTypeId`, `Token`, `TokenParsed` (`FromString`, `fromString`, `encode`, `asToken`), `token`, `tokenFromExecutionId`, and `tokenFromPayload`; external completion `done`, `succeed`, `fail`, and `failCause`.                                                                                                                                                                                                                                                                                                                                                                          |
| `DurableClock`    | `DurableClock`, `make({ name, duration })`, and threshold-aware `sleep(options)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DurableQueue`    | `TypeId`, `DurableQueue`, `make`, flow-side `process`, worker effect `makeWorker`, and worker `layer` constructor `worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `FlowEngine`      | `FlowEngine` service operations `register`, `execute`, `poll`, `interrupt`, `interruptUnsafe`, `resume`, `activityExecute`, `deferredResult`, `deferredDone`, and `scheduleClock`; implementation boundary `Encoded`, `makeUnsafe`, and in-memory `layerMemory`; per-run `FlowInstance` and `FlowInstance.initial`; `ActivityExecuteOptions`; compensable-step `SnapshotBoundaryOptions` and `SnapshotBoundary`; `FlowCycleDetected`.                                                                                                                                                                                                                                                      |
| `FlowProxy`       | `toRpcGroup` / `ConvertRpcs` and `toHttpApiGroup` / `ConvertHttpApi` derive execute, discard, and resume transports from flows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FlowProxyServer` | `layerRpcHandlers`, `layerHttpApi`, and `RpcHandlers` implement the derived transports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RetryPolicy`     | `RetryPolicy` schema/type, `make`, and `defaultRetryPolicy`; decisions `RetryAfter`, `GiveUp`, `RetryDecision`, `retryAfter`, and `giveUp`; `nextDelay`, `nextDelayEffect`, `errorTag`, `isNonRetryable`, `decide`, and `decideEffect`; `RetryAttemptsExhausted`.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Reference implementation

The walkthrough below exercises the entire public API, namespace by
namespace.

### Flow — define, handle, run, observe

```ts
import { Activity, Flow, FlowEngine } from "@smthrs/engine"
import { Effect, Option, Schema } from "effect"

class ReviewFailed extends Schema.TaggedErrorClass<ReviewFailed>()(
  "ReviewFailed",
  { reason: Schema.String }
) {}

// Flow.make: payload fields (or a struct schema), success/error schemas,
// and an optional idempotencyKey for deterministic execution IDs.
const Review = Flow.make("Review", {
  payload: { pr: Schema.String },
  success: Schema.String,
  error: ReviewFailed,
  idempotencyKey: ({ pr }) => pr
})

// Flow annotations: capture defects in results, or park instead of failing.
const Hardened = Review
  .annotate(Flow.CaptureDefects, true)
  .annotate(Flow.SuspendOnFailure, true)

// toLayer registers the flow with a handler; the handler body composes
// activities, clocks, deferreds, and queues (below).
const ReviewHandler = Review.toLayer(({ pr }, executionId) =>
  Effect.gen(function*() {
    const verdict = yield* Activity.make({
      name: "review",
      success: Schema.String,
      execute: Effect.succeed(`lgtm ${pr} (${executionId})`)
    })
    return verdict
  })
)

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
the execution, `Flow.withCompensation(effect, compensation)` attaches
rollback logic, and `Flow.intoResult` / `Flow.wrapActivityResult` convert
handler effects to `Flow.Result` values (serialized via `Flow.Result`,
`Flow.ResultEncoded`, `Flow.Complete.Schema`, and `Flow.Suspended`).
Executing without an execution ID or idempotency key fails with
`Flow.ExecutionIdRequired`.

### Activity — durable steps, tiers, retries, races

```ts
import { Activity, RetryPolicy } from "@smthrs/engine"
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
import { DurableClock } from "@smthrs/engine"

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
import { DurableDeferred } from "@smthrs/engine"
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
declare const Review: import("@smthrs/engine").Flow.Any
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
import { DurableQueue } from "@smthrs/engine"
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

### FlowEngine — the engine contract

```ts
import { FlowEngine } from "@smthrs/engine"
import { Effect } from "effect"

// FlowEngine is the service the flow/activity/deferred/clock/queue APIs
// talk to. layerMemory is the in-memory implementation;
// @smthrs/engine-store provides the durable one. makeUnsafe builds a
// FlowEngine from an Encoded implementation (the persistence boundary).
const program = Effect.gen(function*() {
  const engine = yield* FlowEngine
  // register, execute, poll, interrupt, interruptUnsafe, resume,
  // activityExecute (ActivityExecuteOptions), deferredResult,
  // deferredDone, scheduleClock
}).pipe(Effect.provide(FlowEngine.layerMemory))

// Per-execution state lives in FlowInstance (FlowInstance.initial builds
// one). Compensable activities need a SnapshotBoundary
// (SnapshotBoundaryOptions) in context. Registering a flow that executes
// itself transitively fails with FlowCycleDetected.
```

### FlowProxy / FlowProxyServer — derived transports

```ts
import { FlowProxy, FlowProxyServer } from "@smthrs/engine"
import { Layer } from "effect"
import { HttpApi } from "effect/unstable/http"
import { RpcServer } from "effect/unstable/rpc"

declare const Review: import("@smthrs/engine").Flow.Any

// Each flow derives Execute / Discard / Resume endpoints
// (ConvertRpcs / ConvertHttpApi describe the derived types).
const ReviewRpcs = FlowProxy.toRpcGroup([Review], { prefix: "flows_" })
const ReviewApi = HttpApi.make("api").add(
  FlowProxy.toHttpApiGroup("flows", [Review])
)

// FlowProxyServer implements them against the running engine
// (RpcHandlers names the handler set).
const RpcLayer = RpcServer.layer(ReviewRpcs).pipe(
  Layer.provide(FlowProxyServer.layerRpcHandlers([Review], { prefix: "flows_" }))
)
const HttpLayer = FlowProxyServer.layerHttpApi(ReviewApi, "flows", [Review])
```

### RetryPolicy — declarative retry decisions

```ts
import { RetryPolicy } from "@smthrs/engine"

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
