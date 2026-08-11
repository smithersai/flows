/**
 * Issue #45: the schedule-to-close (`expirationMs`) budget is measured from
 * the durably recorded first attempt, so it survives park/resume and process
 * death instead of restarting on every process.
 */
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Activity, Flow, RetryPolicy } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

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

const provide = <A>(effect: Effect.Effect<A, any, any>, state: DurableEngineState.Service) =>
  runPromise(
    effect.pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, state),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
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
      tier: "sealed",
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

  it("falls back to the earliest surviving attempt row when attempt 1 was pruned (issue #69)", async () => {
    // A retention job deletes the attempt-1 row between processes. The
    // durable origin must degrade to the earliest surviving row — not to a
    // fresh in-process clock, which would silently restore the unbounded
    // budget #45 fixed.
    let dispatches = 0
    const flaky = Activity.make({
      name: "flaky-pruned",
      success: Schema.String,
      error: Schema.String,
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
      owner: { hostId: "retry-origin-pruned-host" },
      journalSource: "retry-origin-pruned-test",
      isAlive: () => Effect.succeed(false)
    })

    // The production SQL journal stack with the database kept reachable, so
    // the test can prune the attempt-1 row like a retention job would.
    const journalWithDatabase = Layer.provideMerge(
      Layer.mergeAll(
        SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
        RunStore.layer,
        AttemptStore.layer,
        CacheStore.layer
      ),
      Layer.provideMerge(Migrations.layer, TestDatabase.layer)
    )

    const result = await runPromise(
      Effect.gen(function*() {
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(OriginFlow, () => flaky as never)
          yield* engine.execute(OriginFlow, {
            executionId: "retry-origin-pruned",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust("25 seconds")
          yield* Effect.yieldNow
        }))
        const dispatchesBeforeRestart = dispatches

        // Retention prunes the attempt-1 row while the run is parked.
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`DELETE FROM flows_attempts WHERE run_id = 'retry-origin-pruned' AND attempt = 1`

        yield* TestClock.adjust("500 seconds")
        yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(OriginFlow, () => flaky as never)
          const fiber = yield* engine.execute(OriginFlow, {
            executionId: "retry-origin-pruned",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust("30 seconds")
          yield* Effect.yieldNow
          yield* Fiber.await(fiber)
        }))
        const store = yield* RunStore.RunStore
        return {
          dispatchesBeforeRestart,
          dispatchesAfterRestart: dispatches,
          row: yield* store.get("retry-origin-pruned")
        }
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(OwnerIdentity.layer),
        Effect.provide(journalWithDatabase),
        Effect.provide(TestClock.layer())
      ) as unknown as Effect.Effect<{
        dispatchesBeforeRestart: number
        dispatchesAfterRestart: number
        row: { status: string; stateJson: string }
      }>
    )

    expect(result.dispatchesBeforeRestart).toBeGreaterThan(1)
    // The budget is measured from the earliest surviving attempt row: the
    // reclaiming process dispatched nothing, where a current-clock fallback
    // would have granted another full 100 seconds of retries.
    expect(result.dispatchesAfterRestart).toBe(result.dispatchesBeforeRestart)
    expect(result.row.status).toBe("failed")
    expect(result.row.stateJson).toContain("RetryPolicyExpired")
  })
})
