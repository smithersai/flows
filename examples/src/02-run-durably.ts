/**
 * Run a flow on the durable engine and read the journal it wrote.
 *
 * The flow body is identical to the in-memory example. What changes is the
 * engine underneath: `EngineStore` claims a run row, fences it with a
 * heartbeat, persists every activity attempt, and commits each lifecycle
 * event in the same transaction as the state transition it describes.
 */
import { Activity, Flow } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

export const Build = Flow.make("examples/Build", {
  payload: { target: Schema.String },
  success: Schema.String
})

/**
 * A sealed activity with a cache key input. The identity is what makes the
 * recorded result addressable across runs; without it the activity would fall
 * back to a run-local invocation key.
 */
export const Compile = Activity.make({
  name: "examples/Compile",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "examples/compile/v1",
  execute: Effect.succeed("dist/server.js")
})

export interface Summary {
  readonly result: string
  readonly eventTypes: ReadonlyArray<string>
}

/** Executes the flow, then reads back the durable journal for that run. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const result = yield* Build.execute({ target: "server" }, { executionId: "build-1" })
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: "build-1" as JournalEvent.RunId, limit: 200 })
    return {
      result,
      eventTypes: page.entries.map((entry) => entry.eventType)
    }
  }).pipe(
    Effect.provide(
      Build.toLayer(({ target }) =>
        Effect.map(Compile, (artifact) => `${artifact}?target=${target}`)
      ).pipe(Layer.provideMerge(durableEngine(filename, "examples-worker")))
    ),
    Effect.scoped,
    Effect.orDie
  )
