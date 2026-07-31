import { Database, NodeDatabase } from "@smithers/database"
import { DurableEngineState, EngineStore, StepBoundary } from "@smithers/engine-store"
import { AttemptStore, CacheStore, Journal, Migrations, RunStore, SqlJournal } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import { Activity, Flow } from "@smithers/engine"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const ForkFlow = Flow.make("TimeTravel/ExecutableFork", {
  payload: {},
  success: Schema.String
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "fork-execution" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const requirements = (filename: string) => {
  const database = NodeDatabase.layer({ filename })
  const migratedDatabase = Layer.provideMerge(Migrations.layer, database)
  const sqlServices = Layer.provideMerge(
    Layer.mergeAll(
      AttemptStore.layer,
      CacheStore.layer,
      RunStore.layer,
      DurableEngineState.layer,
      SqlJournal.layer({ capacity: 64, overflow: "reject" })
    ),
    migratedDatabase
  )
  return Layer.mergeAll(
    sqlServices,
    StepBoundary.layerTest(),
    Layer.succeed(Jj.Jj, jj)
  )
}

describe("SQL fork execution", () => {
  it("drives a fork after restart using copied state and attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-fork-execution-"))
    const filename = join(directory, "fork.sqlite")
    let dispatches = 0
    const activity = Activity.make({
      name: "fork-once",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "fork-execution-v1",
      execute: Effect.sync(() => {
        dispatches++
        return "activity-result"
      })
    })
    const handler = () => activity

    try {
      const created = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "fork-parent" },
              journalSource: "fork-execution",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(ForkFlow, handler)
            const parentResult = yield* engine.execute(ForkFlow, {
              executionId: "fork-parent",
              payload: {},
              discard: false
            })
            const journal = yield* Journal.Journal
            yield* journal.flush
            const { sql } = yield* Database.Database
            const maximum = yield* sql<{ readonly seq: number | null }>`
              SELECT MAX(seq) AS seq
              FROM flows_journal_events
              WHERE run_id = 'fork-parent'
            `
            const store = yield* SqlTimeTravelStore.make
            const fork = yield* store.createFork("fork-parent", {
              lineageId: "fork-parent/root",
              seq: maximum[0]?.seq ?? 0
            })
            const states = yield* sql<{ readonly run_id: string; readonly state_json: string }>`
              SELECT run_id, state_json
              FROM flows_runs
              WHERE run_id IN ('fork-parent', ${fork.runId})
              ORDER BY run_id
            `
            const attempts = yield* sql<{ readonly run_id: string; readonly count: number }>`
              SELECT run_id, COUNT(*) AS count
              FROM flows_attempts
              WHERE run_id IN ('fork-parent', ${fork.runId})
              GROUP BY run_id
              ORDER BY run_id
            `
            return { fork, parentResult, states, attempts }
          }).pipe(Effect.provide(requirements(filename)))
        )
      )

      const childState = JSON.parse(
        created.states.find((row) => row.run_id === created.fork.runId)!.state_json
      ) as Record<string, unknown>
      const parentState = JSON.parse(
        created.states.find((row) => row.run_id === "fork-parent")!.state_json
      ) as Record<string, unknown>
      expect(created.parentResult).toBe("activity-result")
      expect(parentState.result).toBeDefined()
      expect(childState).toMatchObject({
        version: 1,
        flowName: ForkFlow._tag,
        payload: {}
      })
      expect(childState).not.toHaveProperty("result")
      expect(childState).not.toHaveProperty("cancellation")
      expect(created.attempts).toEqual([
        { run_id: "fork-parent", count: 1 },
        { run_id: created.fork.runId, count: 1 }
      ])

      const restarted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "fork-restart" },
              journalSource: "fork-execution",
              isAlive: () => Effect.succeed(false)
            })
            yield* engine.register(ForkFlow, handler)
            const value = yield* engine.execute(ForkFlow, {
              executionId: created.fork.runId,
              payload: {},
              discard: false
            })
            const row = yield* (yield* RunStore.RunStore).get(created.fork.runId)
            return { value, row }
          }).pipe(Effect.provide(requirements(filename)))
        )
      )

      expect(restarted.value).toBe("activity-result")
      expect(restarted.row.status).toBe("completed")
      expect(dispatches).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
