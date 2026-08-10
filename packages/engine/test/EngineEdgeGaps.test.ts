import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { Activity, DurableDeferred, Flow, FlowEngine, RetryPolicy, StepIdentity } from "../src/index.ts"
import { runPromise, runSync } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

describe("Activity.retry outside a flow", () => {
  effect("still advances CurrentAttempt when no engine dispatch fills the ordinal slot", () => {
    // Outside a flow no engine dispatch ever fills the slot (allocation is
    // name-scoped and happens at dispatch, issue #73); the retry wrapper must
    // still work and report attempts.
    const attempts: Array<number> = []
    const body = Effect.gen(function*() {
      const attempt = yield* Activity.CurrentAttempt
      const slot = yield* Activity.CurrentOrdinal
      attempts.push(attempt)
      expect(slot?.values.size).toBe(0)
      return attempt < 3 ? yield* Effect.fail("again") : attempt
    })

    return Effect.gen(function*() {
      expect(yield* Activity.retry(body, { times: 5 })).toBe(3)
      expect(attempts).toEqual([1, 2, 3])
    })
  })

  effect("allocates a single stable ordinal for all attempts inside a flow", () => {
    // The engine fills the retry sequence's slot on the first dispatch and
    // every later attempt reuses it, so the activity keeps one identity
    // across the whole sequence (issue #73).
    const ordinals: Array<number | undefined> = []
    let attempts = 0
    const activity = Activity.make({
      name: "Edge/retry-ordinal-activity",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.gen(function*() {
        attempts++
        return attempts < 3 ? yield* Effect.fail("again") : attempts
      })
    })
    const scope = runSync(
      StepIdentity.allocationScope({
        kind: "activity",
        name: "Edge/retry-ordinal-activity"
      }).pipe(Effect.orDie)
    )
    const body = Effect.gen(function*() {
      const result = yield* activity
      ordinals.push(...(yield* Activity.CurrentOrdinal)?.values.get(scope) ?? [undefined])
      return result
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function*() {
          ordinals.push(...(yield* Activity.CurrentOrdinal)?.values.get(scope) ?? [undefined])
        })
      )
    )
    const flow = Flow.make("Edge/retry-ordinal", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const layer = flow.toLayer(() => Activity.retry(body, { times: 5 })).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(3)
      // one ordinal, reused across every attempt
      expect(ordinals).toEqual([1, 1, 1])
    }).pipe(Effect.provide(layer))
  })
})

describe("DurableDeferred.into", () => {
  effect("records an ordinary failure verbatim rather than treating it as suspension", () => {
    const Result_ = DurableDeferred.make("Edge/into-failure", {
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/into-failure", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    let bodyRuns = 0
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        bodyRuns++
        // the second pass observes the persisted failure without re-running
        return yield* DurableDeferred.into(
          Effect.suspend(() => bodyRuns === 1 ? Effect.fail("into-boom") : Effect.succeed(99)),
          Result_
        )
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const first = yield* flow.execute({ id: "x" }, { executionId: "run-into" }).pipe(Effect.exit)
      expect(Exit.isFailure(first) && Cause.squash(first.cause)).toBe("into-boom")
      const replayed = yield* DurableDeferred.await(Result_).pipe(
        Effect.exit,
        Effect.provideService(
          FlowEngine.FlowInstance,
          FlowEngine.FlowInstance.initial(flow, "run-into")
        )
      )
      expect(Exit.isFailure(replayed) && Cause.squash(replayed.cause)).toBe("into-boom")
    }).pipe(Effect.provide(layer))
  })

  effect("records a success so a later await replays it", () => {
    const Result_ = DurableDeferred.make("Edge/into-success", {
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/into-success", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const layer = flow.toLayer(() => DurableDeferred.into(Effect.succeed(7), Result_)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-into-ok" })).toBe(7)
      expect(
        yield* DurableDeferred.await(Result_).pipe(
          Effect.provideService(
            FlowEngine.FlowInstance,
            FlowEngine.FlowInstance.initial(flow, "run-into-ok")
          )
        )
      ).toBe(7)
    }).pipe(Effect.provide(layer))
  })
})

describe("retry decisions on defects", () => {
  effect("a defect is not a retryable failure and propagates immediately", () => {
    // The retry decision point only classifies typed failures. A defect has no
    // Fail reason, so the policy must not consume attempts on it.
    let attempts = 0
    const activity = Activity.make({
      name: "Edge/dying-activity",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 5 }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.die("kaboom")
      })
    })
    const flow = Flow.make("Edge/dying", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const layer = flow.toLayer(() => activity).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-die" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("kaboom")
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("a typed failure under the same policy is retried to the declared bound", () => {
    let attempts = 0
    const activity = Activity.make({
      name: "Edge/failing-activity",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("again")
      })
    })
    const flow = Flow.make("Edge/failing", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const layer = flow.toLayer(() => activity).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-retry" }).pipe(Effect.exit)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((defect as RetryPolicy.RetryAttemptsExhausted).maxAttempts).toBe(3)
      expect(attempts).toBe(3)
    }).pipe(Effect.provide(layer))
  })
})

describe("in-flight activity identity", () => {
  effect("two concurrent runs of the same keyed activity both execute, then replay after settling", () => {
    // The memory engine memoizes an activity result once it settles. While an
    // attempt is still in flight there is nothing to replay, so a concurrent
    // sibling with the same key runs alongside it; a third, later call
    // replays the settled result.
    let executions = 0
    const keyed = Activity.make({
      name: "Edge/concurrent-keyed",
      success: Schema.Number,
      idempotencyKey: "edge/concurrent",
      execute: Effect.gen(function*() {
        executions++
        for (let i = 0; i < 5; i++) yield* Effect.yieldNow
        return executions
      })
    })
    const flow = Flow.make("Edge/concurrent-keyed", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* Effect.all([keyed, keyed], { concurrency: "unbounded" })
        const inFlight = executions
        expect(inFlight).toBe(2)
        return yield* keyed
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const replayed = yield* flow.execute({ id: "x" }, { executionId: "run-concurrent" })
      // the third call replayed a settled result instead of running again
      expect(executions).toBe(2)
      expect(replayed).toBeLessThanOrEqual(2)
    }).pipe(Effect.provide(layer))
  })
})

describe("waitForZero", () => {
  effect("holds suspension open across several scheduler turns until the last sibling settles", () => {
    const events: Array<string> = []
    const failing = Activity.make({
      name: "Edge/suspending",
      success: Schema.String,
      error: Schema.String,
      execute: Effect.gen(function*() {
        yield* Effect.yieldNow
        return yield* Effect.fail("suspend-now")
      })
    })
    const verySlow = Activity.make({
      name: "Edge/very-slow",
      success: Schema.String,
      execute: Effect.gen(function*() {
        events.push("slow:start")
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow
        events.push("slow:end")
        return "slow"
      })
    })
    const flow = Flow.make("Edge/wait-for-zero", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = flow.toLayer(() =>
      Effect.map(
        Effect.all([failing, verySlow], { concurrency: "unbounded" }),
        ([a, b]) => `${a}+${b}`
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-wait-zero", discard: true })
      let polled = yield* flow.poll("run-wait-zero")
      for (let i = 0; i < 300 && (Option.isNone(polled) || polled.value._tag !== "Suspended"); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-wait-zero")
      }
      expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
      // suspension waited for the long-running sibling to finish first
      expect(events).toEqual(["slow:start", "slow:end"])
    }).pipe(Effect.provide(layer))
  })

  effect("keeps waiting when a sibling starts another activity after the in-flight count hits zero", () => {
    // The in-flight count can briefly return to zero between two sequential
    // activities of a still-running sibling. Suspension must not be released
    // in that window: every activity of the chain has to settle first.
    const ran: Array<string> = []
    const step = (name: string) =>
      Activity.make({
        name,
        success: Schema.String,
        execute: Effect.gen(function*() {
          for (let i = 0; i < 2; i++) yield* Effect.yieldNow
          ran.push(name)
          return name
        })
      })
    const failing = Activity.make({
      name: "Edge/chain-suspender",
      success: Schema.String,
      error: Schema.String,
      execute: Effect.gen(function*() {
        yield* Effect.yieldNow
        return yield* Effect.fail("chain-boom")
      })
    })
    const flow = Flow.make("Edge/chain", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = flow.toLayer(() =>
      Effect.map(
        Effect.all([
          failing,
          Effect.gen(function*() {
            yield* step("Edge/chain-a")
            yield* Effect.yieldNow
            yield* step("Edge/chain-b")
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            yield* step("Edge/chain-c")
            return "chain"
          })
        ], { concurrency: "unbounded" }),
        ([a, b]) => `${a}+${b}`
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-chain", discard: true })
      let polled = yield* flow.poll("run-chain")
      for (let i = 0; i < 300 && (Option.isNone(polled) || polled.value._tag !== "Suspended"); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-chain")
      }
      expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
      expect(ran).toEqual(["Edge/chain-a", "Edge/chain-b", "Edge/chain-c"])
    }).pipe(Effect.provide(layer))
  })
})
