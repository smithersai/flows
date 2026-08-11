/**
 * Fork a finished run at a journal frame and drive the copy.
 *
 * Forking is one call on one service: `yield* TimeTravel` and then
 * `fork(position)`. A position is a run id and a frame — the `(lineageId, seq)`
 * address in the journal — and nothing else. The child run id, the lineage
 * edge back to the parent, and the jj workspace the copy lands in are derived
 * inside the service; the parent is checked for liveness there too.
 *
 * Under the fork, `SqlTimeTravelStore.createFork` derives the parent's
 * executable state AT the frame and copies only the attempt rows the frame's
 * journal prefix can explain. Because those attempts are addressed by sealed
 * cache key, the fork replays them instead of dispatching again, which is why
 * the counter below stays at one. The frame here is the parent's last committed
 * sequence, so the fork inherits everything.
 *
 * The environment declaration matters. A sealed cache key is computed under
 * `Activity.CurrentCacheEnvironment`; with no declaration the engine scopes
 * the key to the execution that produced it, and the fork would re-execute.
 */
import { Activity, Flow } from "@smthrs/flow"
import { EngineStore } from "@smthrs/engine-store"
import { Journal } from "@smthrs/journal"
import { SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { requirements } from "./durable-layer.ts"

export const Analyse = Flow.make("examples/Analyse", {
  payload: {},
  success: Schema.String
})

export interface Summary {
  readonly parentResult: string
  readonly forkResult: string
  readonly forkRunId: string
  readonly dispatches: number
  readonly parentEntryCount: number
}

const engineLayer = (filename: string, hostId: string) =>
  EngineStore.layer({
    owner: { hostId },
    journalSource: `${hostId}-engine`,
    isAlive: () => Effect.succeed(false)
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        requirements(filename),
        // Declaring the environment is what lets a sealed identity cross the
        // fork boundary.
        Activity.layerCacheEnvironment({ layers: [], capabilities: {} })
      )
    )
  )

/**
 * The time-travel service over the same SQLite file the engine writes.
 *
 * `TimeTravel.layer` asks only for injectable contracts — the store, the
 * journal, the run store, the cache, and jj — so it merges straight onto the
 * engine composition. Building it also finishes or rolls back any rewind a
 * crash interrupted, which is why recovery never appears as a call below.
 */
const timeTravelLayer = (filename: string, hostId: string) =>
  TimeTravel.layer.pipe(
    Layer.provideMerge(SqlTimeTravelStore.layer),
    Layer.provideMerge(engineLayer(filename, hostId))
  )

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let dispatches = 0

    const Measure = Activity.make({
      name: "examples/Measure",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "examples/measure/v1",
      execute: Effect.sync(() => {
        dispatches += 1
        return "42"
      })
    })

    const handler = () => Measure

    const forked = yield* Effect.scoped(
      Effect.gen(function*() {
        const parentResult = yield* Analyse.execute({}, { executionId: "analyse-1" })
        const journal = yield* Journal.Journal
        yield* journal.flush

        const page = yield* journal.entries({ runId: "analyse-1" as never, limit: 200 })
        // The frame to fork at: the last committed sequence for this run.
        const seq = page.entries.at(-1)?.seq ?? 0

        const timeTravel = yield* TimeTravel
        const fork = yield* timeTravel.fork({
          runId: "analyse-1",
          frame: { lineageId: "analyse-1/root", seq }
        })

        return { parentResult, forkRunId: fork.runId, parentEntryCount: page.entries.length }
      }).pipe(
        Effect.provide(
          Analyse.toLayer(handler).pipe(Layer.provideMerge(timeTravelLayer(filename, "fork-parent")))
        )
      )
    )

    // A fresh engine drives the fork. The copied attempt rows replay.
    const forkResult = yield* Effect.scoped(
      Analyse.execute({}, { executionId: forked.forkRunId }).pipe(
        Effect.provide(Analyse.toLayer(handler).pipe(Layer.provideMerge(engineLayer(filename, "fork-child"))))
      )
    )

    return {
      parentResult: forked.parentResult,
      forkResult,
      forkRunId: forked.forkRunId,
      dispatches,
      parentEntryCount: forked.parentEntryCount
    }
  }).pipe(Effect.orDie)
