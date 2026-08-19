# Writing a flow

This guide shows how to define schemas, execute named actions, suspend on durable primitives, and register a handler. It focuses on code that can replay safely.

## Define the durable interface

```ts
import { Action, DurableDeferred, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"

class BuildFailure extends Schema.TaggedError<BuildFailure>()(
  "example/BuildFailure",
  { message: Schema.String }
) {}

const Build = Flow.make("example/Build", {
  payload: {
    target: Schema.String,
    sourceDigest: Schema.String
  },
  success: Schema.Struct({ artifact: Schema.String }),
  error: BuildFailure
})
```

Tags and encoded schemas are persistence contracts. Change them with the same care as a database schema.

## Put side effects behind actions

```ts
const Compile = Action.make({
  name: "example/Compile",
  success: Schema.String,
  error: BuildFailure,
  tier: "sealed",
  idempotencyKey: {
    body: "compile-v3",
    inputs: { source: { kind: "literal", value: "source-bytes" } },
    layers: ["typescript-6", "linux-amd64"],
    capabilities: {
      filesystem: ["fs:read:/workspace/src/**", "fs:write:/workspace/out/**"]
    },
    boundary: {
      readSet: [{ path: "/workspace/src", digest: "sha256:tree" }],
      writeSet: ["/workspace/out/**"],
      boundaryMode: "hard"
    }
  },
  execute: Effect.succeed("/workspace/out/server.js"),
  metadata: {
    boundaryMode: "hard",
    readSet: [{ path: "/workspace/src", digest: "sha256:tree" }],
    writeSet: ["/workspace/out/**"]
  }
})
```

The idempotency identity creates the step key. `metadata` is separately decoded as `FileBoundary` by `EngineStore`; malformed or absent metadata means the production boundary cannot prove the action cacheable.

The built-in `StepBoundary.layerTest` accepts a simplified descriptor and is for tests only. A production boundary implementation is application-supplied today.

## Register the handler

```ts
const BuildLayer = Build.toLayer(({ target }) =>
  Effect.gen(function*() {
    const artifact = yield* Compile
    return { artifact: `${artifact}?target=${target}` }
  })
)
```

Provide `BuildLayer` with either `FlowEngine.layerMemory` or an `EngineStore.layer`. Registration is scoped; after the layer’s scope closes, its active fibers and registrations are gone even though durable rows remain.

## Suspend durably

`DurableClock.sleep` records a wake time. `DurableDeferred.await` suspends until another process completes its token. `DurableQueue.process` offers persisted work and awaits its deferred result:

```ts
const Approval = DurableDeferred.make("example/input-ready", {
  success: Schema.String
})

const value = yield* DurableDeferred.await(Approval)
```

The handler re-runs from the beginning after wake. Completed actions and durable primitives return recorded results, so code before the frontier must be deterministic and safe to evaluate again.

## Retry deliberately

```ts
const artifact = yield* Action.retry(Compile, { times: 2 })
```

Use `tier: "irreversible"` for effects that cannot be rolled back, and give them an idempotency key before allowing retries. Use `tier: "compensable"` only when snapshot and restore are meaningful for the supplied `Jj` implementation.

## Declare a model call

A model call is an ordinary action, so it is declared like one — except that its implementation ships with it and an author never writes `toLayer` for it. `AgentAction.make` takes the seat, the system teaching, a prompt built from the step payload, and an `output` schema:

```ts
import * as AgentAction from "@smthrs/engine-harness/AgentAction"

const Review = AgentAction.make("example/Review", {
  payload: { diff: Schema.String },
  output: Schema.Struct({
    approved: Schema.Boolean,
    issues: Schema.Array(Schema.String)
  }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You review diffs."],
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})
```

`Review.call({ diff })` records the same plan node any other action records, and `Review.layer` is the implementation: it runs the cell loop through `CellHarness.run` inside the current execution.

The `output` schema is enforced. It is rendered into the run's system teaching as JSON Schema, and the run's final answer is decoded by it — whole answer first, then the last balanced JSON container inside it. A decode miss spends one correction re-prompt carrying bounded diagnostics before the step fails `StructuredOutputFailure`. Set `corrections: 0` to make a first miss terminal.

The host wiring is one value for the whole composition:

```ts
const HostLayer = AgentAction.layerHost({
  resolveSeat: (seat) => resolveProviderSeat(seat),
  registry,
  limits: { calls: 32 }
})
```

Provide `HostLayer` and `CellHarness.layer` alongside the engine layers. A test swaps `resolveSeat` for a scripted model and needs no API key; see [`11-agent-step.ts`](https://github.com/smithersai/flows/blob/main/examples/src/11-agent-step.ts).

Continue with [Determinism and replay](../concepts/determinism-and-replay.md), [Step keys](../concepts/step-keys.md), and [Failure and retry](../concepts/failure-and-retry.md).
