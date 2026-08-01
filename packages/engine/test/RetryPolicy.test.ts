import { Clock, Effect, Exit, Fiber, Layer, Option, Random, Schema } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine, RetryPolicy } from "../src/index.ts"

const some = (value: number) => Option.some(value)
const none = Option.none()

describe("nextDelay", () => {
  const policy = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })

  it("mirrors the temporal formula: initialMs * factor^(attempt - 1)", () => {
    expect(RetryPolicy.nextDelay(policy, 1)).toEqual(some(100))
    expect(RetryPolicy.nextDelay(policy, 2)).toEqual(some(200))
    expect(RetryPolicy.nextDelay(policy, 3)).toEqual(some(400))
    expect(RetryPolicy.nextDelay(policy, 4)).toEqual(some(800))
  })

  it("caps the delay at maxMs", () => {
    expect(RetryPolicy.nextDelay(policy, 5)).toEqual(some(1000))
    expect(RetryPolicy.nextDelay(policy, 50)).toEqual(some(1000))
  })

  it("gives up when maxAttempts is reached (attempt >= maxAttempts)", () => {
    const bounded = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 3
    })
    expect(RetryPolicy.nextDelay(bounded, 2)).toEqual(some(200))
    expect(RetryPolicy.nextDelay(bounded, 3)).toEqual(none)
    expect(RetryPolicy.nextDelay(bounded, 4)).toEqual(none)
  })

  it("gives up on a non-positive computed interval", () => {
    const zero = RetryPolicy.make({ initialMs: 0, factor: 2, maxMs: 1000 })
    expect(RetryPolicy.nextDelay(zero, 1)).toEqual(none)
    const negative = RetryPolicy.make({ initialMs: -5, factor: 2, maxMs: 1000 })
    expect(RetryPolicy.nextDelay(negative, 1)).toEqual(none)
  })

  it("gives up when the cap falls below the initial interval", () => {
    const inverted = RetryPolicy.make({ initialMs: 500, factor: 2, maxMs: 100 })
    expect(RetryPolicy.nextDelay(inverted, 1)).toEqual(none)
  })

  it("applies jitter from the supplied random sample", () => {
    const jittered = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      jitterRatio: 0.2
    })
    // delay * (1 - ratio) + random * delay * ratio
    expect(RetryPolicy.nextDelay(jittered, 1, { random: 0 })).toEqual(some(80))
    expect(RetryPolicy.nextDelay(jittered, 1, { random: 0.5 })).toEqual(some(90))
    expect(RetryPolicy.nextDelay(jittered, 1, { random: 1 })).toEqual(some(100))
    // Default random of 1 leaves the delay un-jittered.
    expect(RetryPolicy.nextDelay(jittered, 1)).toEqual(some(100))
  })

  it("samples the Random service deterministically under a seed", async () => {
    const jittered = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      jitterRatio: 0.5
    })
    const sample = () =>
      Effect.runPromise(
        RetryPolicy.nextDelayEffect(jittered, 2).pipe(Random.withSeed(42))
      )
    const first = await sample()
    const second = await sample()
    expect(first).toEqual(second)
    const delay = Option.getOrThrow(first)
    expect(delay).toBeGreaterThanOrEqual(100)
    expect(delay).toBeLessThanOrEqual(200)
  })
})

describe("expiration (issue #36)", () => {
  const policy = RetryPolicy.make({
    initialMs: 100,
    factor: 2,
    maxMs: 1000,
    expirationMs: 1_000
  })

  it("gives up when elapsed time plus the next delay would cross the expiration bound", () => {
    // Temporal's ComputeNextDelay: done when elapsed + backoff exceeds the
    // expiration interval, independent of attempt counts.
    expect(RetryPolicy.nextDelay(policy, 1, { elapsedMs: 0 })).toEqual(some(100))
    expect(RetryPolicy.nextDelay(policy, 3, { elapsedMs: 500 })).toEqual(some(400))
    expect(RetryPolicy.nextDelay(policy, 3, { elapsedMs: 700 })).toEqual(none)
    expect(RetryPolicy.nextDelay(policy, 1, { elapsedMs: 1_000 })).toEqual(none)
  })

  it("ignores elapsed time when the policy declares no expiration", () => {
    const unbounded = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })
    expect(RetryPolicy.nextDelay(unbounded, 5, { elapsedMs: Number.MAX_SAFE_INTEGER })).toEqual(some(1000))
  })

  it("decide reports the expired give-up distinctly from exhaustion", () => {
    const decision = RetryPolicy.decide(policy, {
      attempt: 2,
      error: new Error("still down"),
      elapsedMs: 5_000
    })
    expect(decision).toEqual({ _tag: "GiveUp", reason: "expired" })
  })

  it("an expressible wall-clock bound stops an activity retrying against a dead dependency", async () => {
    let attempts = 0
    const activity = Activity.make({
      name: "RetryPolicy/expires",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({
        initialMs: 100,
        factor: 1,
        maxMs: 100,
        expirationMs: 250
      }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("dependency-down")
      })
    })
    const flow = Flow.make("RetryPolicy/expiring-flow", {
      payload: {},
      success: Schema.Number,
      error: Schema.String
    })

    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* FlowEngine.FlowEngine
        const fiber = yield* engine.activityExecute(activity, 1).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        // Attempts at t=0, 100, 200; the delay to t=300 crosses the 250ms
        // expiration, so the sequence stops with a die.
        yield* TestClock.adjust(1_000)
        const result = yield* Fiber.join(fiber)
        return result._tag === "Complete" ? result.exit : Exit.succeed("suspended" as never)
      }).pipe(
        Effect.provide(
          flow.toLayer(() => Effect.succeed(0)).pipe(
            Layer.provideMerge(FlowEngine.layerMemory)
          )
        ),
        Effect.provideService(
          FlowEngine.FlowInstance,
          FlowEngine.FlowInstance.initial(flow, "retry-policy-expires")
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    )

    expect(attempts).toBe(3)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("retry_policy_expired")
    }
  })
})

describe("decide", () => {
  it("short-circuits a nonRetryable-tagged error to giveUp on attempt 1", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: ["FatalError"]
    })
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "FatalError" } })
    ).toEqual(RetryPolicy.giveUp("nonRetryable"))
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "OtherError" } })
    ).toEqual(RetryPolicy.retryAfter(100))
  })

  it("matches an Error instance by name", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: ["TypeError"]
    })
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: new TypeError("boom") })
    ).toEqual(RetryPolicy.giveUp("nonRetryable"))
  })

  it("returns exhausted when the policy runs out of attempts", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 2
    })
    expect(RetryPolicy.decide(policy, { attempt: 1, error: "e" })).toEqual(
      RetryPolicy.retryAfter(100)
    )
    expect(RetryPolicy.decide(policy, { attempt: 2, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })
})

// Parity: Temporal `common/backoff/retry_test.go:285` (duration overflow) and
// `retrypolicy_test.go:269` (constant / conditional policies).
describe("nextDelay numeric boundaries", () => {
  it("clamps an overflowing exponential to maxMs instead of returning Infinity", () => {
    const explosive = RetryPolicy.make({
      initialMs: 1000,
      factor: 1e6,
      maxMs: 30000
    })
    // 1000 * 1e6^999 overflows IEEE754 to Infinity before the cap is applied.
    const delay = RetryPolicy.nextDelay(explosive, 1000)
    expect(Option.isSome(delay)).toBe(true)
    if (Option.isSome(delay)) {
      expect(Number.isFinite(delay.value)).toBe(true)
      expect(delay.value).toBe(30000)
    }
  })

  it("clamps at the largest finite attempt index without producing NaN", () => {
    const policy = RetryPolicy.make({ initialMs: 1, factor: 2, maxMs: 60000 })
    for (const attempt of [1024, Number.MAX_SAFE_INTEGER]) {
      const delay = RetryPolicy.nextDelay(policy, attempt)
      expect(Option.isSome(delay)).toBe(true)
      if (Option.isSome(delay)) {
        expect(Number.isNaN(delay.value)).toBe(false)
        expect(delay.value).toBe(60000)
      }
    }
  })

  it("keeps an overflowing delay clamped once jitter is applied", () => {
    const jittered = RetryPolicy.make({
      initialMs: 1000,
      factor: 1e6,
      maxMs: 30000,
      jitterRatio: 0.5
    })
    expect(RetryPolicy.nextDelay(jittered, 1000, { random: 0 })).toEqual(some(15000))
    expect(RetryPolicy.nextDelay(jittered, 1000, { random: 1 })).toEqual(some(30000))
  })

  it("expresses a constant-delay policy as factor 1", () => {
    const constant = RetryPolicy.make({ initialMs: 250, factor: 1, maxMs: 250 })
    for (const attempt of [1, 2, 7, 500]) {
      expect(RetryPolicy.nextDelay(constant, attempt)).toEqual(some(250))
    }
  })

  it("a constant policy with maxAttempts stops exactly at the bound", () => {
    const constant = RetryPolicy.make({
      initialMs: 250,
      factor: 1,
      maxMs: 250,
      maxAttempts: 4
    })
    expect(RetryPolicy.decide(constant, { attempt: 3, error: "e" })).toEqual(
      RetryPolicy.retryAfter(250)
    )
    expect(RetryPolicy.decide(constant, { attempt: 4, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("a fractional factor still never dips below the initial interval", () => {
    const decaying = RetryPolicy.make({ initialMs: 100, factor: 0.5, maxMs: 1000 })
    expect(RetryPolicy.nextDelay(decaying, 1)).toEqual(some(100))
    // attempt 2 computes 50ms, which is below initialMs, so the policy gives up
    expect(RetryPolicy.nextDelay(decaying, 2)).toEqual(none)
    expect(RetryPolicy.decide(decaying, { attempt: 2, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("maxAttempts of 1 refuses to retry the very first failure", () => {
    const once = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 1
    })
    expect(RetryPolicy.nextDelay(once, 1)).toEqual(none)
    expect(RetryPolicy.decide(once, { attempt: 1, error: "e" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("nonRetryable classification wins over an otherwise valid delay and over exhaustion", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      maxAttempts: 1,
      nonRetryable: ["Fatal"]
    })
    expect(
      RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "Fatal" } })
    ).toEqual(RetryPolicy.giveUp("nonRetryable"))
    // an untagged error at the same attempt is exhausted, not nonRetryable
    expect(RetryPolicy.decide(policy, { attempt: 1, error: "plain" })).toEqual(
      RetryPolicy.giveUp("exhausted")
    )
  })

  it("errorTag reads _tag, then Error name, and is otherwise undefined", () => {
    expect(RetryPolicy.errorTag({ _tag: "Tagged" })).toBe("Tagged")
    expect(RetryPolicy.errorTag(new RangeError("x"))).toBe("RangeError")
    expect(RetryPolicy.errorTag({ _tag: 7 })).toBe(undefined)
    expect(RetryPolicy.errorTag("string")).toBe(undefined)
    expect(RetryPolicy.errorTag(null)).toBe(undefined)
  })

  it("an empty nonRetryable list classifies nothing as non-retryable", () => {
    const policy = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      nonRetryable: []
    })
    expect(RetryPolicy.isNonRetryable(policy, { _tag: "Anything" })).toBe(false)
    expect(RetryPolicy.decide(policy, { attempt: 1, error: { _tag: "Anything" } })).toEqual(
      RetryPolicy.retryAfter(100)
    )
  })

  it("decideEffect skips the Random service when jitter is absent or zero", async () => {
    const noJitter = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 })
    const zeroJitter = RetryPolicy.make({
      initialMs: 100,
      factor: 2,
      maxMs: 1000,
      jitterRatio: 0
    })
    for (const policy of [noJitter, zeroJitter]) {
      const decision = await Effect.runPromise(
        RetryPolicy.decideEffect(policy, { attempt: 1, error: "e" })
      )
      expect(decision).toEqual(RetryPolicy.retryAfter(100))
      const delay = await Effect.runPromise(RetryPolicy.nextDelayEffect(policy, 1))
      expect(delay).toEqual(some(100))
    }
  })
})

describe("defaultRetryPolicy", () => {
  it("mirrors the historical exponential(200, 1.5) / spaced(30000) envelope", () => {
    expect(RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 1)).toEqual(some(200))
    expect(RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 2)).toEqual(some(300))
    expect(RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 3)).toEqual(some(450))
    expect(
      RetryPolicy.nextDelay(RetryPolicy.defaultRetryPolicy, 100)
    ).toEqual(some(30000))
  })
})

describe("flow suspension policy", () => {
  it("preserves the policy through annotations and forwards it to execution", () => {
    const policy = RetryPolicy.make({ initialMs: 17, factor: 1, maxMs: 17 })
    const suspended = Flow.make("RetryPolicy/suspended", {
      payload: {},
      success: Schema.Void,
      suspendedRetryPolicy: policy
    }).annotate(Flow.CaptureDefects, true)
    let attempts = 0
    const layer = suspended.toLayer(() =>
      Effect.gen(function*() {
        attempts++
        if (attempts === 1) {
          const instance = yield* FlowEngine.FlowInstance
          return yield* Flow.suspend(instance)
        }
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    expect(suspended.suspendedRetryPolicy).toBe(policy)
    return Effect.gen(function*() {
      const fiber = yield* suspended.execute({}, { executionId: "suspended-policy" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(16)
      expect(attempts).toBe(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(attempts).toBe(2)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(TestClock.layer())
    )
  })
})

// -----------------------------------------------------------------------------
// Engine integration
// -----------------------------------------------------------------------------

const flow = Flow.make("RetryPolicy/test", {
  payload: {},
  success: Schema.Void
})

const effect = (
  name: string,
  body: () => Effect.Effect<
    void,
    unknown,
    Scope.Scope | FlowEngine.FlowEngine | FlowEngine.FlowInstance
  >,
  executionId = "retry-policy"
) =>
  it(name, () =>
    Effect.runPromise(
      body().pipe(
        Effect.provide(FlowEngine.layerMemory),
        Effect.provideService(
          FlowEngine.FlowInstance,
          FlowEngine.FlowInstance.initial(flow, executionId)
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    ))

class Flaky extends Schema.TaggedErrorClass<Flaky>()("RetryPolicy/Flaky", {}) {}
class Fatal extends Schema.TaggedErrorClass<Fatal>()("RetryPolicy/Fatal", {}) {}

describe("engine retry decision point", () => {
  effect("retries a failing activity with policy-derived backoff", () =>
    Effect.gen(function*() {
      const timestamps: Array<number> = []
      const activity = Activity.make({
        name: "RetryPolicy/backoff",
        success: Schema.Number,
        error: Flaky,
        retryPolicy: RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 }),
        execute: Effect.gen(function*() {
          timestamps.push(yield* Clock.currentTimeMillis)
          return timestamps.length >= 4
            ? timestamps.length
            : yield* Effect.fail(new Flaky())
        })
      })
      const fiber = yield* activity.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      // attempts at t=0, 100, 300 (=100+200), 700 (=300+400)
      yield* TestClock.adjust(700)
      const result = yield* Fiber.join(fiber)
      expect(result).toBe(4)
      expect(timestamps).toEqual([0, 100, 300, 700])
    }))

  effect("maxAttempts exhaustion fails with a typed RetryAttemptsExhausted defect", () =>
    Effect.gen(function*() {
      let attempts = 0
      const activity = Activity.make({
        name: "RetryPolicy/exhausted",
        success: Schema.Void,
        error: Flaky,
        retryPolicy: RetryPolicy.make({
          initialMs: 100,
          factor: 2,
          maxMs: 1000,
          maxAttempts: 3
        }),
        execute: Effect.suspend(() => {
          attempts++
          return Effect.fail(new Flaky())
        })
      })
      const fiber = yield* activity.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(300)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(3)
      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit)
        ? exit.cause.reasons.find((reason) => reason._tag === "Die")
        : undefined
      expect(defect).toBeDefined()
      const error = (defect as { defect: unknown }).defect
      expect(Schema.is(RetryPolicy.RetryAttemptsExhausted)(error)).toBe(true)
      expect((error as RetryPolicy.RetryAttemptsExhausted).attempt).toBe(3)
      expect((error as RetryPolicy.RetryAttemptsExhausted).maxAttempts).toBe(3)
      // the terminal operation failure is not discarded by the exhaustion
      // wrapper: callers can still recover the error that actually ended the
      // retry sequence (Temporal `retry_test.go:222` parity)
      // it is stored in its *encoded* form so the defect stays serializable
      const last = (error as RetryPolicy.RetryAttemptsExhausted).lastError
      expect(last).toEqual({ _tag: "RetryPolicy/Flaky" })
    }))

  effect("the exhaustion defect carries the *final* failure, not the first one", () =>
    Effect.gen(function*() {
      let attempts = 0
      const activity = Activity.make({
        name: "RetryPolicy/exhausted-last-error",
        success: Schema.Void,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({
          initialMs: 100,
          factor: 1,
          maxMs: 100,
          maxAttempts: 3
        }),
        execute: Effect.suspend(() => Effect.fail(`failure-${++attempts}`))
      })
      const fiber = yield* activity.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(300)
      const exit = yield* Fiber.join(fiber)
      const defect = Exit.isFailure(exit)
        ? exit.cause.reasons.find((reason) => reason._tag === "Die")
        : undefined
      const error = (defect as { defect: unknown }).defect as RetryPolicy.RetryAttemptsExhausted
      expect(attempts).toBe(3)
      expect(error.lastError).toBe("failure-3")
    }))

  effect(
    "a nonRetryable-tagged error short-circuits to the original failure on attempt 1",
    () =>
      Effect.gen(function*() {
        let attempts = 0
        const before = yield* Clock.currentTimeMillis
        const activity = Activity.make({
          name: "RetryPolicy/nonRetryable",
          success: Schema.Void,
          error: Fatal,
          retryPolicy: RetryPolicy.make({
            initialMs: 100,
            factor: 2,
            maxMs: 1000,
            nonRetryable: ["RetryPolicy/Fatal"]
          }),
          execute: Effect.suspend(() => {
            attempts++
            return Effect.fail(new Fatal())
          })
        })
        const exit = yield* activity.pipe(Effect.exit)
        expect(attempts).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Clock.currentTimeMillis).toBe(before)
      })
  )

  effect("without a retryPolicy a failing activity is not retried", () =>
    Effect.gen(function*() {
      let attempts = 0
      const activity = Activity.make({
        name: "RetryPolicy/none",
        success: Schema.Void,
        error: Flaky,
        execute: Effect.suspend(() => {
          attempts++
          return Effect.fail(new Flaky())
        })
      })
      const exit = yield* activity.pipe(Effect.exit)
      expect(attempts).toBe(1)
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("restart resume", () => {
  // Simulates the durable resume path: attempts 1..2 run and fail under one
  // engine, the process "dies", and a FRESH engine (fresh fiber-local state
  // over the shared attempt log) resumes at the persisted attempt count + 1.
  // The backoff before the next attempt must be derived from that persisted
  // count, not reset to initialMs.
  it("resumes at attempt N+1 with policy backoff derived from the persisted attempt count", async () => {
    // Shared "durable store": the attempt numbers each engine executed.
    const attemptLog: Array<{ attempt: number; at: number }> = []
    const policy = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 10000 })
    const activity = Activity.make({
      name: "RetryPolicy/restart",
      success: Schema.Number,
      error: Flaky,
      retryPolicy: policy,
      execute: Effect.gen(function*() {
        const attempt = yield* Activity.CurrentAttempt
        const at = yield* Clock.currentTimeMillis
        attemptLog.push({ attempt, at })
        return attemptLog.length >= 4 ? attempt : yield* Effect.fail(new Flaky())
      })
    })

    const runIn = <A, E>(
      body: Effect.Effect<
        A,
        E,
        Scope.Scope | FlowEngine.FlowEngine | FlowEngine.FlowInstance
      >
    ) =>
      Effect.runPromise(
        body.pipe(
          Effect.provide(FlowEngine.layerMemory),
          Effect.provideService(
            FlowEngine.FlowInstance,
            FlowEngine.FlowInstance.initial(flow, "retry-policy-restart")
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

    // Engine A: attempts 1 and 2 fail, then the process dies mid-backoff.
    await runIn(Effect.gen(function*() {
      const engine = yield* FlowEngine.FlowEngine
      const fiber = yield* engine.activityExecute(activity, 1).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(100)
      yield* Fiber.interrupt(fiber)
    }))
    expect(attemptLog.map(({ attempt }) => attempt)).toEqual([1, 2])

    // Engine B: a fresh engine resumes from the persisted attempt count.
    const persisted = attemptLog[attemptLog.length - 1]!.attempt
    await runIn(Effect.gen(function*() {
      const engine = yield* FlowEngine.FlowEngine
      const fiber = yield* engine
        .activityExecute(activity, persisted + 1)
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      // Attempt 3 runs immediately and fails; the delay before attempt 4
      // must be nextDelay(policy, 3) = 400ms — not reset to initialMs.
      yield* TestClock.adjust(399)
      expect(attemptLog.length).toBe(3)
      yield* TestClock.adjust(1)
      const result = yield* Fiber.join(fiber)
      expect(result._tag).toBe("Complete")
    }))
    expect(attemptLog.map(({ attempt }) => attempt)).toEqual([1, 2, 3, 4])
    // Engine B's clock: attempt 3 at t=0, attempt 4 exactly 400ms later.
    expect(attemptLog[3]!.at - attemptLog[2]!.at).toBe(400)
  })
})
