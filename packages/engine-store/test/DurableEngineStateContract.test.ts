import { Database } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Migrations } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import { describeContract, type Harness, type HarnessContext } from "./contract/DurableEngineStateContract.ts"

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const sqlHarness: Harness = {
  label: "sql",
  run: (body) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const database = yield* Database.Database
        const state = yield* DurableEngineState.make
        const context: HarnessContext = {
          state,
          restart: DurableEngineState.make.pipe(
            Effect.provideService(Database.Database, database)
          ),
          seedRun: (runId, owner, status = "running", heartbeatAtMs = owner === null ? null : 0) =>
            database.sql`
              INSERT INTO flows_runs (
                run_id,
                status,
                created_at_ms,
                owner_host_id,
                owner_pid,
                owner_nonce,
                heartbeat_at_ms,
                state_json
              ) VALUES (
                ${runId},
                ${status},
                0,
                ${owner?.hostId ?? null},
                ${owner?.pid ?? null},
                ${owner?.nonce ?? null},
                ${heartbeatAtMs},
                '{}'
              )
            `.pipe(Effect.orDie, Effect.asVoid),
          setCancelRequested: (runId, requestedAtMs) =>
            database.sql`
              UPDATE flows_runs
              SET cancel_requested_at_ms = ${requestedAtMs}
              WHERE run_id = ${runId}
            `.pipe(Effect.orDie, Effect.asVoid),
          setStatus: (runId, status) =>
            database.sql`
              UPDATE flows_runs
              SET
                status = ${status},
                owner_host_id = NULL,
                owner_pid = NULL,
                owner_nonce = NULL,
                heartbeat_at_ms = NULL
              WHERE run_id = ${runId}
            `.pipe(Effect.orDie, Effect.asVoid)
        }
        return yield* body(context)
      }).pipe(Effect.provide(migratedDatabase)) as Effect.Effect<never>
    )
}

const memoryHarness: Harness = {
  label: "memory",
  run: (body) => {
    const runs = new Map<string, DurableEngineState.MemoryRunView>()
    const state = DurableEngineState.makeMemory({
      runs: (runId) => Option.fromNullishOr(runs.get(runId)),
      listRuns: () => runs.entries()
    })
    const context: HarnessContext = {
      state,
      // The in-memory storage lives in the service closure itself, so the
      // restart shape is the shared-instance model the existing memory
      // restart tests already use.
      restart: Effect.succeed(state),
      seedRun: (runId, owner, status = "running", heartbeatAtMs = owner === null ? null : 0) =>
        Effect.sync(() => {
          runs.set(runId, { status, owner, heartbeatAtMs })
        }),
      setCancelRequested: (runId, requestedAtMs) =>
        Effect.sync(() => {
          const view = runs.get(runId)
          if (view !== undefined) {
            runs.set(runId, { ...view, cancelRequestedAtMs: requestedAtMs })
          }
        }),
      setStatus: (runId, status) =>
        Effect.sync(() => {
          runs.set(runId, { status, owner: null })
        })
    }
    return Effect.runPromise(body(context) as Effect.Effect<never>)
  }
}

describeContract(sqlHarness)
describeContract(memoryHarness)
