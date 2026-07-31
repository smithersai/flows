# @smithers/engine

Flows fork of Effect's unstable workflow API. It defines typed flows,
activities, durable waits/queues, transport projections, and the low-level
engine contract; `@smithers/engine-store` supplies durable persistence.

```sh
npm install @smithers/engine
```

## Public API

The root exports these namespaces, also available from matching
`@smithers/engine/*` subpaths.

| Namespace         | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Flow`            | `Flow` plus erased/schema helper types `AnyStructSchema`, `Execution`, `Any`, `AnyWithProps`, `PayloadSchema`, `RequirementsClient`, and `RequirementsHandler`; `make`; result guard/schema/models `isResult`, `Result`, `ResultEncoded`, `CompleteEncoded`, `CompleteSchema`, `Complete`, and `Suspended`; runtime helpers `intoResult`, `wrapActivityResult`, `scope`, `provideScope`, `addFinalizer`, `withCompensation`, and `suspend`; annotations `CaptureDefects` and `SuspendOnFailure`; `ExecutionIdRequired`. A flow value exposes `execute`, `poll`, `interrupt`, `resume`, `executionId`, `toLayer`, annotation methods, and `withCompensation`. |
| `Activity`        | `Activity`, `Any`, and `AnyWithProps`; durability `Tier` and `IdempotencyKey`; `make`, `retry`, `idempotencyKey`, and `raceAll`; attempt references `CurrentAttempt` and `CurrentOrdinal`; errors `InfraInterrupt` and `IrreversibleRetryRequiresIdempotencyKey`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `DurableDeferred` | `DurableDeferred`, `Any`, and `AnyWithProps`; `make`, `await`, `into`, and `raceAll`; token API `TokenTypeId`, `Token`, `TokenParsed`, `token`, `tokenFromExecutionId`, and `tokenFromPayload`; external completion `done`, `succeed`, `fail`, and `failCause`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `DurableClock`    | `DurableClock`, `make({ name, duration })`, and threshold-aware `sleep(options)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DurableQueue`    | `TypeId`, `DurableQueue`, `make`, flow-side `process`, worker effect `makeWorker`, and worker `layer` constructor `worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FlowEngine`      | `FlowEngine` service operations `register`, `execute`, `poll`, `interrupt`, `interruptUnsafe`, `resume`, `activityExecute`, `deferredResult`, `deferredDone`, and `scheduleClock`; implementation boundary `Encoded`, `makeUnsafe`, and in-memory `layerMemory`; per-run `FlowInstance`; `ActivityExecuteOptions`; compensable-step `SnapshotBoundaryOptions` and `SnapshotBoundary`; `FlowCycleDetected`.                                                                                                                                                                                                                                                   |
| `FlowProxy`       | `toRpcGroup` / `ConvertRpcs` and `toHttpApiGroup` / `ConvertHttpApi` derive execute, discard, and resume transports from flows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FlowProxyServer` | `layerRpcHandlers`, `layerHttpApi`, and `RpcHandlers` implement the derived transports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RetryPolicy`     | `RetryPolicy` schema/type, `make`, and `defaultRetryPolicy`; decisions `RetryAfter`, `GiveUp`, `RetryDecision`, `retryAfter`, and `giveUp`; `nextDelay`, `nextDelayEffect`, `errorTag`, `isNonRetryable`, `decide`, and `decideEffect`; `RetryAttemptsExhausted`.                                                                                                                                                                                                                                                                                                                                                                                            |

```ts
import { Activity, Flow, FlowEngine } from "@smithers/engine"
import { Effect, Schema } from "effect"

const Review = Flow.make("Review", {
  payload: { pr: Schema.String },
  success: Schema.String
})

const handler = Review.toLayer(({ pr }) =>
  Activity.make({
    name: "review",
    success: Schema.String,
    execute: Effect.succeed(pr)
  })
)

const program = Review.execute({ pr: "42" }, { executionId: "run-17" }).pipe(
  Effect.provide(handler),
  Effect.provide(FlowEngine.layerMemory)
)
```

An execution needs either an explicit `executionId` or a flow
`idempotencyKey`. Activity tiers are `sealed`, `compensable`, and
`irreversible`; compensable activities require `SnapshotBoundary`, while an
irreversible retry requires an activity idempotency key.

See the [engine reference](../../docs/reference/engine.md),
[Vendored Workflow Engine](../../../docs/specs/Concepts/Vendored%20Workflow%20Engine.md),
[Failure Policy](../../../docs/specs/Concepts/Failure%20Policy.md), and
[Step Keys](../../../docs/specs/Concepts/Step%20Keys.md).
