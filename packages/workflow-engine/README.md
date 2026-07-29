# @flows/workflow-engine

@flows/workflow-engine is the flows fork of Effect's unstable workflow API.
The module layout matches the upstream
reference/effect/packages/effect/src/unstable/workflow tree. The fork adds
content-addressed activity identity, durability tiers, explicit execution IDs,
snapshot boundaries, and an optional resume signal.

~~~text
Workflow → Activity → WorkflowEngine
             ├─ DurableDeferred
             ├─ DurableClock
             └─ DurableQueue
WorkflowProxy / WorkflowProxyServer derive RPC and HTTP surfaces.
~~~

~~~ts
import { Activity, Workflow, WorkflowEngine } from "@flows/workflow-engine"
import { Effect, Schema } from "effect"

const Review = Workflow.make("Review", {
  payload: { pr: Schema.String },
  success: Schema.String
})

const program = Review.execute({ pr: "42" }, { executionId: "run-17" }).pipe(
  Effect.provide(Review.toLayer(({ pr }) =>
    Activity.make({ name: "review", success: Schema.String, execute: Effect.succeed(pr) })
  )),
  Effect.provide(WorkflowEngine.layerMemory)
)
~~~

Root namespaces are Activity, DurableClock, DurableDeferred, DurableQueue,
Workflow, WorkflowEngine, WorkflowProxy, and WorkflowProxyServer. See the
[reference](../../docs/reference/workflow-engine.md) for every exported type,
constructor, service, and outcome.
