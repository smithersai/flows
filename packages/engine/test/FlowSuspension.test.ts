import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { Activity, DurableDeferred, Flow, FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>,
  predicate: (result: Flow.Result<A, E>) => boolean
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 50 && (Option.isNone(result) || !predicate(result.value)); i++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

const isSuspended = (result: Flow.Result<any, any>) => result._tag === "Suspended"
const isComplete = (result: Flow.Result<any, any>) => result._tag === "Complete"

describe("SuspendOnFailure", () => {
  effect("a failing flow suspends instead of completing, carrying the cause as a defect", () => {
    const flow = Flow.make("Suspend/on-failure", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    }).annotate(Flow.SuspendOnFailure, true)

    let attempts = 0
    const layer = flow.toLayer(() =>
      Effect.suspend(() => {
        attempts++
        return attempts === 1 ? Effect.fail("nope") : Effect.succeed("ok")
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "f" }, { discard: true })
      const suspended = yield* pollUntil(flow.poll(executionId), isSuspended)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      // the failure is retained on the suspended result as a defect
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        expect(suspended.value.cause).toBeDefined()
        expect(String(suspended.value.cause)).toContain("nope")
      }
      expect(attempts).toBe(1)

      // resuming re-runs the handler, which now succeeds
      yield* flow.resume(executionId)
      const done = yield* pollUntil(flow.poll(executionId), isComplete)
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("ok")
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("without the annotation the same failure completes as a typed failure", () => {
    const flow = Flow.make("Suspend/no-annotation", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() => Effect.fail("nope")).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "g" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("interrupting a suspend-on-failure flow discards the execution rather than suspending it", () => {
    const flow = Flow.make("Suspend/interrupted", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = flow.toLayer(() => Effect.never as Effect.Effect<string>).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "h" }, { discard: true })
      yield* Effect.yieldNow
      yield* flow.interrupt(executionId).pipe(Effect.exit)
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      // external interruption is terminal for the memory engine: nothing is left to resume
      expect(Option.isNone(yield* flow.poll(executionId))).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})

describe("concurrent activity suspension", () => {
  const Gate = DurableDeferred.make("Suspend/Gate", {
    success: Schema.String,
    error: Schema.String
  })

  effect("suspension cancels concurrent siblings, which run exactly once after resumption", () => {
    let slowRuns = 0
    const slow = Activity.make({
      name: "Suspend/slow",
      success: Schema.String,
      idempotencyKey: "suspend/slow",
      execute: Effect.gen(function*() {
        slowRuns++
        for (let i = 0; i < 5; i++) yield* Effect.yieldNow
        return "slow"
      })
    })

    const flow = Flow.make("Suspend/concurrent", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })

    const layer = flow.toLayer(() =>
      Effect.map(
        Effect.all([DurableDeferred.await(Gate), slow], { concurrency: "unbounded" }),
        ([gated, slowValue]) => `${gated}+${slowValue}`
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "c" }, { discard: true })
      const suspended = yield* pollUntil(flow.poll(executionId), isSuspended)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      // the unresolved deferred suspends the whole flow before the sibling activity settles
      expect(slowRuns).toBe(0)

      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: "gate" })

      const done = yield* pollUntil(flow.poll(executionId), isComplete)
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("gate+slow")
      // the sibling ran on the resumed pass only — never twice
      expect(slowRuns).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
