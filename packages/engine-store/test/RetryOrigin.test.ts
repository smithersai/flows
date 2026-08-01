/**
 * Issue #45: the schedule-to-close (`expirationMs`) budget is measured from
 * the durably recorded first attempt, so it survives park/resume and process
 * death instead of restarting on every process.
 */
import { Activity, Flow, RetryPolicy } from "@smithers/engine"
import { RunStore, TestJournal } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

const OriginFlow = Flow.make("RetryOrigin/Flow", {
  payload: {},
  success: Schema.String
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "retry-origin-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const provide = <A>(effect: Effect.Effect<A, never, any>, state: DurableEngineState.Service) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, state),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestJournal.layer()),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

describe("durable schedule-to-close origin", () => {
  it("does not restart the retry budget when a new process re-drives the run", async () => {
    let dispatches = 0
    const flaky = Activity.make({
      name: "flaky",
      success: Schema.String,
      error: Schema.String,
      tier: "trusted",
      retryPolicy: RetryPolicy.make({
        initialMs: 10_000,
        factor: 1,
        maxMs: 10_000,
        expirationMs: 100_000,
        maxAttempts: 50
      }),
      execute: Effect.suspend(() => {
        dispatches++
        return Effect.fail("boom")
      })
    })
    const state = DurableEngineState.makeMemory()
    const makeEngine = EngineStore.make({
      owner: { hostId: "retry-origin-host" },
      journalSource: "retry-origin-test",
      isAlive: () => Effect.succeed(false)
    })

    const result = await provide(
      Effect.gen(function*() {
        // First process: a few failed attempts, then the process goes away
        // mid-backoff and the run is released for reclaim.
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(OriginFlow, () => flaky as never)
          yield* engine.execute(OriginFlow, {
            executionId: "retry-origin",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust("25 seconds")
          yield* Effect.yieldNow
        }))
        const store = yield* RunStore.RunStore
        const dispatchesBeforeRestart = dispatches
        const released = yield* store.get("retry-origin")

        // Long outage: by the time a second process picks the run up, the
        // 100s schedule-to-close budget measured from attempt 1 is spent.
        yield* TestClock.adjust("500 seconds")
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(OriginFlow, () => flaky as never)
          const fiber = yield* engine.execute(OriginFlow, {
            executionId: "retry-origin",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust("30 seconds")
          yield* Effect.yieldNow
          yield* Fiber.await(fiber)
        }))
        return {
          dispatchesBeforeRestart,
          dispatchesAfterRestart: dispatches,
          releasedStatus: released.status,
          row: yield* store.get("retry-origin")
        }
      }),
      state
    )

    expect(result.releasedStatus).toBe("suspended")
    expect(result.dispatchesBeforeRestart).toBeGreaterThan(1)
    // The reclaiming process dispatched nothing: a fresh in-process clock
    // would have granted another full 100 seconds of retries.
    expect(result.dispatchesAfterRestart).toBe(result.dispatchesBeforeRestart)
    expect(result.row.status).toBe("failed")
    expect(result.row.stateJson).toContain("RetryPolicyExpired")
  })
})
