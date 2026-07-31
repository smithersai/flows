# @smithers/engine

@smithers/engine is the flows fork of Effect's unstable flow API.
The module layout matches the upstream
reference/effect/packages/effect/src/unstable/flow tree. The fork adds
content-addressed activity identity, durability tiers, explicit execution IDs,
snapshot boundaries, and an optional resume signal.

```text
Flow → Activity → FlowEngine
             ├─ DurableDeferred
             ├─ DurableClock
             └─ DurableQueue
FlowProxy / FlowProxyServer derive RPC and HTTP surfaces.
```

```ts
import { Activity, Flow, FlowEngine } from "@smithers/engine"
import { Effect, Schema } from "effect"

const Review = Flow.make("Review", {
  payload: { pr: Schema.String },
  success: Schema.String
})

const program = Review.execute({ pr: "42" }, { executionId: "run-17" }).pipe(
  Effect.provide(
    Review.toLayer(({ pr }) => Activity.make({ name: "review", success: Schema.String, execute: Effect.succeed(pr) }))
  ),
  Effect.provide(FlowEngine.layerMemory)
)
```

Root namespaces are Activity, DurableClock, DurableDeferred, DurableQueue,
Flow, FlowEngine, FlowProxy, and FlowProxyServer. See the
[reference](../../docs/reference/engine.md) for every exported type,
constructor, service, and outcome.
