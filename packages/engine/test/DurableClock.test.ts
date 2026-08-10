import { Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Activity, DurableClock, DurableDeferred, Flow, FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const pollComplete = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 10 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      result = yield* poll
    }
    return result
  })

describe("DurableClock", () => {
  effect("make derives a deferred named after the clock", () =>
    Effect.sync(() => {
      const clock = DurableClock.make({ name: "make/one", duration: "5 seconds" })
      expect(clock.name).toBe("make/one")
      expect(clock.deferred.name).toBe("DurableClock/make/one")
      expect(clock.duration).toEqual(Duration.seconds(5))
    }))

  effect("a zero duration sleep returns without waiting on the clock", () => {
    const flow = Flow.make("DurableClock/zero", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* DurableClock.sleep({ name: "zero", duration: 0 })
        return "immediate"
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      // no TestClock.adjust: a zero sleep must not wait for time to pass
      expect(yield* flow.execute({ id: "z" }, { executionId: "zero" })).toBe("immediate")
    }).pipe(Effect.provide(layer))
  })

  effect("sleeps at or below the in-memory threshold never suspend the flow", () => {
    const flow = Flow.make("DurableClock/in-memory", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.as(
        DurableClock.sleep({ name: "short", duration: "1 second" }),
        "slept"
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "s" }, { discard: true })
      const pending = yield* flow.poll(executionId)
      // an in-memory sleep keeps running in the fiber instead of suspending
      expect(Option.isNone(pending)).toBe(true)

      yield* TestClock.adjust("1 second")
      const result = yield* pollComplete(flow.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("slept")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("the in-memory threshold boundary is inclusive and configurable", () => {
    const flow = Flow.make("DurableClock/threshold", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.as(
        DurableClock.sleep({
          name: "boundary",
          duration: "2 minutes",
          inMemoryThreshold: "2 minutes"
        }),
        "slept"
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "b" }, { discard: true })
      // a duration equal to the configured threshold stays in memory (default
      // threshold is 60 seconds, so this would otherwise be durable)
      expect(Option.isNone(yield* flow.poll(executionId))).toBe(true)

      yield* TestClock.adjust("2 minutes")
      const result = yield* pollComplete(flow.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("sleeps above the threshold suspend the flow until the durable clock fires", () => {
    const flow = Flow.make("DurableClock/durable", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* DurableClock.sleep({
          name: "long",
          duration: "10 minutes",
          inMemoryThreshold: "1 second"
        })
        return "woke"
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "d" }, { discard: true })
      yield* TestClock.adjust("9 minutes")
      const pending = yield* flow.poll(executionId)
      expect(Option.isSome(pending) && pending.value._tag).toBe("Suspended")

      yield* TestClock.adjust("1 minute")
      const result = yield* pollComplete(flow.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("woke")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("sequential durable sleeps each wake at their own deadline", () => {
    const flow = Flow.make("DurableClock/sequential", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const marks: Array<string> = []
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* DurableClock.sleep({
          name: "first",
          duration: "5 minutes",
          inMemoryThreshold: "1 second"
        })
        yield* Activity.make({
          name: "sequential/mark-first",
          tier: "sealed",
          idempotencyKey: "sequential/mark-first",
          success: Schema.Void,
          execute: Effect.sync(() => {
            marks.push("first")
          })
        })
        yield* DurableClock.sleep({
          name: "second",
          duration: "5 minutes",
          inMemoryThreshold: "1 second"
        })
        return marks.length
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "q" }, { discard: true })
      yield* TestClock.adjust("5 minutes")
      yield* Effect.yieldNow
      const midway = yield* flow.poll(executionId)
      expect(marks).toEqual(["first"])
      expect(Option.isSome(midway) && midway.value._tag).toBe("Suspended")

      yield* TestClock.adjust("5 minutes")
      const result = yield* pollComplete(flow.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(1)
      }
    }).pipe(Effect.provide(layer))
  })

  effect("an early wake wins the race against the armed timer, which then fires into a no-op", () => {
    const flow = Flow.make("DurableClock/early-wake", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    let bodiesPastSleep = 0
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* DurableClock.sleep({
          name: "wakeable",
          duration: "10 minutes",
          inMemoryThreshold: "1 second"
        })
        return ++bodiesPastSleep
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "e" }, { discard: true })
      yield* TestClock.adjust("1 minute")
      expect(Option.isSome(yield* flow.poll(executionId))).toBe(true)

      const clock = DurableClock.make({ name: "wakeable", duration: "10 minutes" })
      const token = DurableDeferred.tokenFromExecutionId(clock.deferred, { flow, executionId })
      yield* DurableDeferred.succeed(clock.deferred, { token, value: undefined })

      const woken = yield* pollComplete(flow.poll(executionId))
      expect(Option.isSome(woken) && woken.value._tag).toBe("Complete")
      expect(bodiesPastSleep).toBe(1)

      // the timer still fires at its original deadline; it must not resume the
      // already-completed flow or overwrite the recorded wake
      yield* TestClock.adjust("10 minutes")
      yield* Effect.yieldNow
      const settled = yield* flow.poll(executionId)
      expect(Option.isSome(settled) && settled.value._tag).toBe("Complete")
      expect(bodiesPastSleep).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("re-scheduling an armed clock keeps the original deadline", () =>
    Effect.gen(function*() {
      const flow = Flow.make("DurableClock/duplicate", {
        payload: { id: Schema.String },
        success: Schema.Void,
        idempotencyKey: ({ id }) => id
      })
      const engine = yield* FlowEngine.FlowEngine
      const first = DurableClock.make({ name: "dup", duration: "10 minutes" })
      const second = DurableClock.make({ name: "dup", duration: "1 minute" })
      yield* engine.scheduleClock(flow, { executionId: "dup", clock: first })
      yield* engine.scheduleClock(flow, { executionId: "dup", clock: second })

      const instance = FlowEngine.FlowInstance.initial(flow, "dup")
      const read = engine.deferredResult(first.deferred).pipe(
        Effect.provideService(FlowEngine.FlowInstance, instance)
      )
      expect(Option.isNone(yield* read)).toBe(true)
      yield* TestClock.adjust("1 minute")
      // the shorter duplicate must not shorten the already-armed deadline
      expect(Option.isNone(yield* read)).toBe(true)
      yield* TestClock.adjust("9 minutes")
      expect(Option.isSome(yield* read)).toBe(true)
    }).pipe(Effect.provide(FlowEngine.layerMemory)))
})
