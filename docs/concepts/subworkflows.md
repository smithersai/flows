# Subworkflows

This page explains how a workflow starts and waits for another registered workflow in the current engine. It covers attached parent/child execution, not a general detached workflow graph.

## Attached child execution

A workflow handler can execute another workflow with an explicit child execution ID:

```ts
const childResult = yield* Compile.execute(
  { target: "server" },
  { executionId: `${parentExecutionId}/compile` }
)
```

When `EngineStore` detects that execution inside a running workflow, it:

1. creates or reuses a separate child run,
2. stores the parent execution ID on that child,
3. suspends the parent while the child is incomplete,
4. resumes the parent after the child reaches a terminal result.

The child has its own run ownership, journal entries, activity attempts, and payload/result schemas. Re-executing the parent observes the persisted child result instead of starting another child with the same execution ID.

## Identity requirements

Every workflow execution must have either:

- an explicit `executionId`, or
- a workflow-level `idempotencyKey` from which `Workflow.executionId` can derive one.

For child workflows, an explicit ID derived from stable parent input is usually easier to audit. An ID derived from timing, randomness, or branch scheduling is not replay-safe.

## Interruption

The engine contract exposes `interrupt` and `interruptUnsafe`. The memory engine lets `interrupt` resume cooperatively so workflow cleanup can run, while `interruptUnsafe` interrupts its fiber. `EngineStore` currently maps both operations to the same durable interruption path and does not implement structured child cancellation. Do not rely on durable parent interruption to cancel descendants automatically.

## Detached children and lineage

The public workflow API does not currently expose a first-class detached-child option. The time-travel store can represent `child`, `fork`, and `continuation` lineage edges, and rewind has policy for detached descendants, but EngineStore does not automatically record all of that lineage.

First-class detached execution, automatic durable lineage, and structured parent cancellation policy are **Planned**.

See [Durable execution model](durable-execution-model.md), [Time travel](time-travel.md), and the [`@flows/workflow-engine` reference](../reference/workflow-engine.md).
