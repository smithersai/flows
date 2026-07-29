# Getting started

This guide runs a typed workflow with the in-memory engine. It is the shortest executable path through `@flows/workflow-engine`; it does not provide process-crash durability.

## Prerequisites

The repository is unreleased. Use the workspace checkout and Node.js 22.19 or newer:

```sh
npm install
npm run check
```

When consuming the packages from another workspace, add the packages you use as workspace or file dependencies until releases exist.

## Define and run a workflow

```ts
import { Workflow, WorkflowEngine } from "@flows/workflow-engine"
import { Effect, Layer, Schema } from "effect"

const Greeting = Workflow.make("example/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String
})

const GreetingLayer = Greeting.toLayer(({ name }) =>
  Effect.succeed(`Hello, ${name}.`)
).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory)
)

const program = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
)

console.log(
  await Effect.runPromise(program.pipe(Effect.provide(GreetingLayer)))
)
```

`Workflow.make` defines durable schemas and a stable workflow tag. `toLayer` registers the handler with whichever `WorkflowEngine` is supplied. `execute` requires a caller-selected execution ID because this workflow did not opt into an idempotency key.

## Derive an execution ID

Use a workflow idempotency key only when identical keys truly mean the same logical execution:

```ts
const Greeting = Workflow.make("example/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ name }) => name.normalize("NFC").toLowerCase()
})

const executionId = yield* Greeting.executionId({ name: "Ada" })
```

An explicit `executionId` always wins. Without either source, execution dies with `Workflow.ExecutionIdRequired` before invoking the engine.

## Choose the next guide

- Add durable boundaries in [Writing a workflow](writing-a-workflow.md).
- Replace memory state with the SQL-backed composition in [Assembling a durable engine](durable-engine.md).
- Build deterministic fixtures in [Testing](testing.md).

The [Durable execution model](../concepts/durable-execution-model.md) explains what changes when the durable engine is used.
