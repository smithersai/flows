# @smthrs/flow

The flow authoring model: typed flow and activity definitions, durable primitives, step identity, retry policy, and the runtime port they execute against. The whole package bundles for the browser; durability comes from whichever runtime you provide.

```ts
import { Activity, Flow } from "@smthrs/flow"
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Build = Flow.make("example/Build", {
  payload: { target: Schema.String },
  success: Schema.String
})

const Compile = Activity.make({
  name: "example/Compile",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: { operation: "compile/v1" },
  execute: Effect.succeed("out.js")
})

const layer = Build.toLayer(() => Compile).pipe(Layer.provideMerge(FlowEngine.layerMemory))
```

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/flow` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/index.ts) | any |

## Flow

[src/Flow](https://github.com/smithersai/flows/tree/main/packages/flow/src/Flow)

| Export | Kind | Notes |
| --- | --- | --- |
| `make` | constructor | `Flow.make(tag, { payload, success, error?, idempotencyKey? })` |
| `Flow` | interface | carries `execute`, `executionId`, `toLayer`, `poll`, `interrupt`, `resume` |
| `Execution` | interface | one invocation identified by `executionId` |
| `Any`, `AnyWithProps`, `AnyStructSchema` | interfaces | variance helpers |
| `PayloadSchema`, `RequirementsClient`, `RequirementsHandler` | types | derived schema and requirement types |
| `Complete`, `Suspended` | classes | the two result shapes |
| `CompleteSchema`, `CompleteEncoded` | interfaces | encoded completion |
| `Result`, `ResultEncoded` | type + schema | the result union and its codec |
| `isResult` | guard | |
| `intoResult` | combinator | turns a suspension interrupt into `Suspended` |
| `wrapActivityResult` | combinator | encodes an activity exit for storage |
| `suspend` | effect | suspends the current flow |
| `scope`, `provideScope`, `addFinalizer` | scope helpers | flow-scoped finalizers |
| `withRollback` | combinator | undoes a successful effect if the enclosing flow later fails |
| `CaptureDefects`, `SuspendOnFailure` | references | engine policy switches |
| `ExecutionIdRequired` | class | fails when neither an id nor an idempotency key is supplied |

## Activity

[src/Activity/](https://github.com/smithersai/flows/tree/main/packages/flow/src/Activity)

| Export | Kind | Notes |
| --- | --- | --- |
| `make` | constructor | `name`, `success`, `error?`, `tier`, `idempotencyKey?`, `execute`, `metadata?`, `interruptRetryPolicy?` |
| `Activity`, `Any`, `AnyWithProps` | interfaces | |
| `Tier` | type | `sealed`, `compensable`, `irreversible` |
| `IdempotencyKey` | schema + type | a string, or a caller-owned JSON object |
| `idempotencyKey` | function | resolves the declared key for a payload |
| `retry` | combinator | increments `CurrentAttempt` and delegates scheduling to Effect |
| `raceAll` | combinator | races activities, persisting one winner |
| `CurrentAttempt` | reference | the one-based durable attempt |
| `CurrentOrdinal`, `OrdinalSlot` | reference + interface | the per-scope ordinal used for invocation keys |
| `CacheEnvironment`, `CurrentCacheEnvironment`, `layerCacheEnvironment` | interface + reference + layer | declared layers and capability identity folded into cache keys |
| `InfraInterrupt` | class | infrastructure interruption, retried only under `interruptRetryPolicy` |
| `IrreversibleRetryRequiresIdempotencyKey` | class | irreversible retry without a key |
| `ConcurrentKeylessDispatch` | class | two live dispatches of one keyless activity |
| `UncanonicalIdempotencyKey` | class | a key that canonical serialization rejects |

## Durable primitives

| Export | Source | Notes |
| --- | --- | --- |
| `DurableDeferred.make`, `into`, `raceAll`, `done`, `succeed`, `fail`, `failCause` | [src/DurableDeferred.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/DurableDeferred.ts) | await suspends the flow until a first exit is stored |
| `DurableDeferred.Token`, `TokenParsed`, `TokenTypeId`, `token`, `tokenFromExecutionId`, `tokenFromPayload` | same | addressable completion tokens |
| `DurableDeferred.DurableDeferred`, `Any`, `AnyWithProps` | same | |
| `DurableClock.make`, `sleep`, `DurableClock` | [src/DurableClock.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/DurableClock.ts) | absolute deadlines that re-arm on restart |
| `DurableQueue.make`, `process`, `worker`, `makeWorker`, `DurableQueue`, `TypeId` | [src/DurableQueue.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/DurableQueue.ts) | persisted queue plus a concurrency-limited worker layer |

## RetryPolicy

[src/RetryPolicy.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/RetryPolicy.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RetryPolicy` | schema + type | data-shaped policy with `expirationMs` |
| `make`, `defaultRetryPolicy` | constructors | |
| `nextDelay`, `nextDelayEffect` | functions | pure and effectful backoff |
| `decide`, `decideEffect` | functions | the decision point, driven by the persisted attempt count |
| `RetryDecision`, `RetryAfter`, `GiveUp` | type + interfaces | |
| `retryAfter`, `giveUp` | constructors | |
| `errorTag`, `isNonRetryable`, `defaultNonRetryable` | helpers | error classification |
| `RetryPolicyExpired`, `RetryAttemptsExhausted` | classes | terminal retry failures |

## StepIdentity

[src/Activity/StepIdentity.ts](https://github.com/smithersai/flows/blob/main/packages/flow/src/Activity/StepIdentity.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `AllocationIdentity` | interface | activity name refined by a declared string key |
| `allocationScope` | function | the scope an ordinal is allocated from |
| `invocationKey` | function | builds the run-local ordinal step key |

## FlowRuntime

[src/FlowRuntime](https://github.com/smithersai/flows/tree/main/packages/flow/src/FlowRuntime)

The execution contract the authoring APIs are written against. This package declares it and depends on nothing that implements it, so the dependency runs `@smthrs/flow` ← `@smthrs/engine` only.

| Export | Kind | Notes |
| --- | --- | --- |
| `FlowRuntime` | service | Register, execute, poll, interrupt, resume, execute activities, read and complete deferreds, schedule clocks |
| `FlowInstance` | service | One execution's mutable frontier state: execution id, flow, scope, suspension/interruption flags, waiting annotation, activity coordination |
| `annotateWaiting` | combinator | Declares how the flow is about to wait, so a durable driver parks the run under that reason and token |
| `WaitingAnnotation` | model | `{ reason, wakeAt?, token? }` |
| `FlowCycleDetected` | error | Executing a flow would close a cycle in the persisted parent chain; part of the `execute` contract |
