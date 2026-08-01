/**
 * Pins issue #44: the parked-run cancel sweeper (the issue #27 delivery
 * mechanism) must survive a transient defect from `waitingRuns()` — e.g. a
 * `SQLITE_BUSY` escaping the SQL implementation's `orDie` — instead of dying
 * silently for the rest of the process lifetime. The sweep gets the same
 * sandbox-and-log hardening `armClock` received.
 */
import { DurableDeferred, Flow, type FlowEngine } from "@smithers/engine"
import { Ownership, RunStore, TestJournal } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "sweeper-resilience-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

describe("the cancel sweeper survives transient defects (issue #44)", () => {
  it("delivers a parked cancel after waitingRuns defects once with SQLITE_BUSY", async () => {
    const state = DurableEngineState.makeMemory()
    // A transiently busy database: the first sweep poll escapes as a defect,
    // exactly like the SQL implementation's `orDie` on a `SQLITE_BUSY`.
    let busyPolls = 1
    const flakyState: DurableEngineState.Service = {
      ...state,
      waitingRuns: (options) =>
        busyPolls-- > 0
          ? Effect.die(new Error("SQLITE_BUSY: database is locked"))
          : state.waitingRuns(options)
    }

    const EventFlow = Flow.make("SweeperResilience/Cancel", {
      payload: {},
      success: Schema.String
    })
    const gate = DurableDeferred.make("sweeper-resilience-gate", { success: Schema.String })

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const engine = (yield* EngineStore.make({
            owner: { hostId: "sweeper-resilience-host" },
            journalSource: "sweeper-resilience-test",
            isAlive: () => Effect.succeed(false)
          })) as FlowEngine.FlowEngine["Service"]

          yield* engine.register(
            EventFlow as never,
            (() => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)) as never
          )
          yield* engine.execute(EventFlow as never, {
            executionId: "sweeper-resilience-cancel",
            payload: {},
            discard: true
          })
          const nowMs = yield* Clock.currentTimeMillis
          yield* store.requestCancel("sweeper-resilience-cancel", nowMs)

          // First tick hits the busy database and must not kill the sweeper.
          yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
          const afterBusy = yield* store.get("sweeper-resilience-cancel")

          let row = afterBusy
          for (let i = 0; i < 10 && row.status !== "cancelled"; i++) {
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            row = yield* store.get("sweeper-resilience-cancel")
          }
          return { afterBusy, row, remainingBusyPolls: busyPolls }
        }).pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, flakyState),
          Effect.provideService(Jj.Jj, jj)
        )
      ).pipe(
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestJournal.layer()),
        Effect.provide(TestClock.layer())
      ) as Effect.Effect<{
        afterBusy: RunStore.Run
        row: RunStore.Run
        remainingBusyPolls: number
      }>
    )

    // The defect was actually exercised…
    expect(result.remainingBusyPolls).toBeLessThanOrEqual(0)
    expect(result.afterBusy.status).toBe("suspended")
    // …and the sweeper survived it to deliver the cancel on a later tick.
    expect(result.row.status).toBe("cancelled")
    expect(result.row.owner).toBeNull()
  })
})
