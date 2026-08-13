// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The in-memory engine's durable-wait paths: scheduled clocks, externally
 * completed deferreds, interruption of a parked execution, and the no-op
 * shape of driving an execution the engine has never seen.
 *
 * The authoring semantics of `DurableClock`, `DurableDeferred`, and
 * suspension live in `@smthrs/flow`'s suite. What is asserted here is the
 * engine's side of the same interaction.
 */
import { Activity, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const pollSuspended = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 20 && Option.isNone(result); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      result = yield* poll
    }
    return result
  })

const pollComplete = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      result = yield* poll
    }
    return result
  })

describe("FlowEngine.layerMemory durable waits", () => {
  const ParkedActivityDeclaration = Activity.make("Memory/Parked/activity", {
    payload: { id: Schema.String },
    success: Schema.String
  })
  const Parked = Flow.make("Memory/Parked", {
    payload: { id: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => ParkedActivityDeclaration.call(payload)
  })
  const gate = DurableDeferred.make("Memory/gate", { success: Schema.String })

  const ParkedLayer = Layer.mergeAll(
    ParkedActivityDeclaration.toLayer(() => DurableDeferred.await(gate)),
    Interpreter.layer(Parked)
  ).pipe(
    Layer.provideMerge(Activity.layerImplementations)
  ).pipe(
    Layer.provideMerge(FlowEngine.layerMemory)
  )

  effect("records a deferred result once and resumes the parked execution", () =>
    Effect.gen(function*() {
      const executionId = yield* Parked.execute({ id: "wake" }, { discard: true })
      expect(Option.isSome(yield* pollSuspended(Parked.poll(executionId)))).toBe(true)

      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Parked, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: "first" })
      const woken = yield* pollComplete(Parked.poll(executionId))
      expect(Option.isSome(woken) && woken.value._tag).toBe("Complete")

      // re-driving a completed execution is a no-op, and a second completion
      // of the same deferred is ignored rather than overwritten
      yield* Parked.resume(executionId)
      yield* DurableDeferred.succeed(gate, { token, value: "second" })
      const settled = yield* pollComplete(Parked.poll(executionId))
      expect(
        Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit._tag
      ).toBe("Success")
    }).pipe(Effect.provide(ParkedLayer)))

  effect("interrupting a parked execution drives it to a terminal result", () =>
    Effect.gen(function*() {
      const executionId = yield* Parked.execute({ id: "cancel" }, { discard: true })
      expect(Option.isSome(yield* pollSuspended(Parked.poll(executionId)))).toBe(true)
      yield* Parked.interrupt(executionId)
      yield* Effect.yieldNow
      const polled = yield* Parked.poll(executionId)
      expect(Option.isSome(polled)).toBe(true)
    }).pipe(Effect.provide(ParkedLayer)))

  effect("resuming or interrupting an unknown execution is a no-op", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.resume(Parked, "never-started")
      yield* engine.interrupt(Parked, "never-started")
      expect(Option.isNone(yield* Parked.poll("never-started"))).toBe(true)
    }).pipe(Effect.provide(ParkedLayer)))

  effect("arms a scheduled clock and completes its deferred at the deadline", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const clock = DurableClock.make({ name: "armed", duration: "10 minutes" })
      yield* engine.scheduleClock(Parked, { executionId: "clock-run", clock })

      const instance = FlowEngine.makeInstance(Parked, "clock-run")
      const read = engine.deferredResult(clock.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(Option.isNone(yield* read)).toBe(true)
      yield* TestClock.adjust("10 minutes")
      expect(Option.isSome(yield* read)).toBe(true)
    }).pipe(Effect.provide(FlowEngine.layerMemory)))
})
