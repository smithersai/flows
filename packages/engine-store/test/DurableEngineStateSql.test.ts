import { Database, TestDatabase } from "@smithers/database"
import { Migrations, type Ownership } from "@smithers/journal"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"

const owner: Ownership.OwnerId = {
  hostId: "durable-state",
  pid: 1,
  nonce: "owner"
}

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const insertOwnedRun = (runId: string) =>
  Effect.gen(function*() {
    const { sql } = yield* Database.Database
    yield* sql`
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
        'running',
        0,
        ${owner.hostId},
        ${owner.pid},
        ${owner.nonce},
        0,
        '{}'
      )
    `
  })

describe("SQL DurableEngineState", () => {
  it("preserves the first deferred completion across competing services", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* insertOwnedRun("deferred-race")
        const first = yield* DurableEngineState.make
        const second = yield* DurableEngineState.make
        const address = {
          flowName: "DurableState/Flow",
          executionId: "deferred-race",
          deferredName: "answer"
        }
        const outcomes = yield* Effect.all([
          first.completeDeferred({
            ...address,
            exit: Exit.succeed("left"),
            metadata: { writer: "left" },
            completedAtMs: 10
          }),
          second.completeDeferred({
            ...address,
            exit: Exit.succeed("right"),
            metadata: { writer: "right" },
            completedAtMs: 11
          })
        ], { concurrency: "unbounded" })
        const completedDeferreds = second.completedDeferreds
        if (completedDeferreds === undefined) {
          return yield* Effect.die(new Error("SQL state does not expose completion recovery"))
        }
        return {
          outcomes,
          row: Option.getOrThrow(yield* first.deferred(address)),
          completed: yield* completedDeferreds(address.flowName)
        }
      }).pipe(Effect.provide(migratedDatabase))
    )

    expect(result.outcomes.map((outcome) => outcome._tag).sort()).toEqual([
      "Completed",
      "Existing"
    ])
    expect(result.outcomes[0]!.row).toEqual(result.outcomes[1]!.row)
    const exit = result.row.exit as Exit.Exit<string>
    expect(Exit.isSuccess(exit) && ["left", "right"].includes(exit.value)).toBe(true)
    expect(result.completed).toEqual([{
      flowName: "DurableState/Flow",
      executionId: "deferred-race",
      deferredName: "answer"
    }])
  })

  it("fences clock creation and completes a deadline with one compare-and-set winner", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* insertOwnedRun("clock-race")
        const first = yield* DurableEngineState.make
        const second = yield* DurableEngineState.make
        const clock = {
          flowName: "DurableState/Flow",
          executionId: "clock-race",
          clockName: "wake",
          deferredName: "DurableClock/wake",
          dueAtMs: 100,
          completedAtMs: null
        }
        const scheduled = yield* first.scheduleClock(clock, owner)
        const duplicate = yield* second.scheduleClock(
          { ...clock, dueAtMs: 200 },
          owner
        )
        const stale = yield* Effect.exit(first.scheduleClock(
          { ...clock, clockName: "stale" },
          { ...owner, nonce: "stale" }
        ))
        const completions = yield* Effect.all([
          first.completeClock(clock, 100),
          second.completeClock(clock, 101)
        ], { concurrency: "unbounded" })
        return {
          scheduled,
          duplicate,
          stale,
          completions,
          row: Option.getOrThrow(yield* first.clock(clock)),
          due: yield* first.dueClocks(Number.MAX_SAFE_INTEGER)
        }
      }).pipe(Effect.provide(migratedDatabase))
    )

    expect(result.scheduled._tag).toBe("Scheduled")
    expect(result.duplicate).toMatchObject({
      _tag: "Existing",
      row: { dueAtMs: 100 }
    })
    expect(Exit.isFailure(result.stale) && Cause.hasInterruptsOnly(result.stale.cause)).toBe(true)
    expect(result.completions.map((outcome) => outcome._tag).sort()).toEqual([
      "AlreadyCompleted",
      "Completed"
    ])
    expect([100, 101]).toContain(result.row.completedAtMs)
    expect(result.due).toEqual([])
  })
})
