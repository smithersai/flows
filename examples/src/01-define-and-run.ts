/**
 * Define a typed flow and run it on the in-memory engine.
 *
 * This is the shortest complete program in the library. `Flow.make` declares
 * the durable schemas and the stable flow tag, `toLayer` registers the handler
 * with whichever engine is in scope, and `FlowEngine.layerMemory` supplies an
 * engine that keeps its state in the process.
 */
import { Flow, FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String
})

const GreetingLayer = Greeting.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)).pipe(
  Layer.provideMerge(FlowEngine.layerMemory)
)

/**
 * Runs the flow under a caller-selected execution ID. The flow declares no
 * `idempotencyKey`, so an explicit id is required.
 */
export const main: Effect.Effect<string> = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(Effect.provide(GreetingLayer))
