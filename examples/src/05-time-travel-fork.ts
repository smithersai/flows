/**
 * Fork a finished run at a journal frame and drive the copy.
 *
 * `SqlTimeTravelStore.createFork` copies the parent's executable state and its
 * attempt rows into a new run id, then records the lineage edge. Because the
 * copied attempts are addressed by sealed cache key, the fork replays them
 * instead of dispatching again, which is why the counter below stays at one.
 *
 * The environment declaration matters. A sealed cache key is computed under
 * `Activity.CurrentCacheEnvironment`; with no declaration the engine scopes
 * the key to the execution that produced it, and the fork would re-execute.
 */
import { Database } from "@smthrs/database"
import { Activity, Flow } from "@smthrs/engine"
import { EngineStore } from "@smthrs/engine-store"
import { Journal } from "@smthrs/journal"
import { SqlTimeTravelStore } from "@smthrs/time-travel"
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

        // The frame to fork at: the last committed sequence for this run.
        const { sql } = yield* Database.Database
        const rows = yield* sql<{ readonly seq: number | null }>`
          SELECT MAX(seq) AS seq FROM flows_journal_events WHERE run_id = 'analyse-1'
        `
        const seq = rows[0]?.seq ?? 0

        const store = yield* SqlTimeTravelStore.make
        const fork = yield* store.createFork("analyse-1", { lineageId: "analyse-1/root", seq })

        const page = yield* journal.entries({ runId: "analyse-1" as never, limit: 200 })

        return { parentResult, forkRunId: fork.runId, parentEntryCount: page.entries.length }
      }).pipe(Effect.provide(Analyse.toLayer(handler).pipe(Layer.provideMerge(engineLayer(filename, "fork-parent")))))
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
