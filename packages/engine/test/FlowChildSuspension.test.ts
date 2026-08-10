// Deep reviewed and polished by a human on 2026-08-10.

import { Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { Activity, DurableDeferred, Flow, FlowEngine, RetryPolicy } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>,
  predicate: (result: Flow.Result<A, E>) => boolean
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 200 && (Option.isNone(result) || !predicate(result.value)); i++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

const isSuspended = (result: Flow.Result<any, any>) => result._tag === "Suspended"
const isComplete = (result: Flow.Result<any, any>) => result._tag === "Complete"

describe("activity suspension", () => {
  effect("an activity that waits on an unresolved deferred suspends the flow and replays once resolved", () => {
    const Gate = DurableDeferred.make("Child/activity-gate", {
      success: Schema.String
    })
    let bodyRuns = 0
    const gated = Activity.make({
      name: "Child/gated-activity",
      success: Schema.String,
      execute: Effect.gen(function*() {
        bodyRuns++
        return yield* DurableDeferred.await(Gate)
      })
    })
    const flow = Flow.make("Child/activity-suspends", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const layer = flow.toLayer(() => Effect.map(gated, (value) => `got:${value}`)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-activity-gate", discard: true })
      const suspended = yield* pollUntil(flow.poll("run-activity-gate"), isSuspended)
      expect(Option.isSome(suspended)).toBe(true)
      expect(bodyRuns).toBe(1)

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow,
        executionId: "run-activity-gate"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: "open" })

      const done = yield* pollUntil(flow.poll("run-activity-gate"), isComplete)
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("got:open")
      // the suspended attempt is not cached as a result: the body re-runs and
      // completes on the resumed pass
      expect(bodyRuns).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})

describe("child flow suspension and interruption", () => {
  effect("a suspended child suspends its parent until the child's gate opens", () => {
    const Gate = DurableDeferred.make("Child/child-gate", { success: Schema.Number })
    const child = Flow.make("Child/gated-child", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const parent = Flow.make("Child/waiting-parent", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const layer = Layer.mergeAll(
      child.toLayer(() => DurableDeferred.await(Gate)),
      parent.toLayer(() => Effect.map(child.execute({ n: 1 }, { executionId: "child-gated" }), (n) => n + 1))
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      yield* parent.execute({ id: "x" }, { executionId: "parent-gated", discard: true })
      const suspended = yield* pollUntil(parent.poll("parent-gated"), isSuspended)
      expect(Option.isSome(suspended)).toBe(true)
      // the child's suspension propagated: the parent is parked, not failed
      expect(Option.isSome(yield* pollUntil(child.poll("child-gated"), isSuspended))).toBe(true)

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: child,
        executionId: "child-gated"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 41 })

      const done = yield* pollUntil(parent.poll("parent-gated"), isComplete)
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  // An interrupted parent must not leave a live child behind. The engine
  // registers a finalizer on every child execution: when the parent's scope
  // closes while the parent is interrupted and the child has not completed,
  // the child is interrupted; otherwise it is left alone.
  const childInterruptionMatrix: ReadonlyArray<
    readonly [string, boolean, "Suspended" | "Complete", ReadonlyArray<string>]
  > = [
    ["interrupted parent, suspended child", true, "Suspended", ["child-exec"]],
    ["interrupted parent, completed child", true, "Complete", []],
    ["live parent, suspended child", false, "Suspended", []],
    ["live parent, completed child", false, "Complete", []]
  ]

  for (const [label, parentInterrupted, childOutcome, expected] of childInterruptionMatrix) {
    effect(`${label} → interrupts ${expected.length === 0 ? "nothing" : "the child"}`, () => {
      const interruptCalls: Array<string> = []
      const child = Flow.make("Child/matrix-child", {
        payload: { n: Schema.Number },
        success: Schema.Number
      })
      const parentFlow = Flow.make("Child/matrix-parent", {
        payload: { id: Schema.String },
        success: Schema.Number
      })
      const scripted = FlowEngine.makeUnsafe({
        register: () => Effect.void,
        execute: (() =>
          Effect.succeed(
            childOutcome === "Complete"
              ? new Flow.Complete({ exit: Exit.succeed(1) })
              : new Flow.Suspended({})
          )) as any,
        poll: () => Effect.succeedNone,
        interrupt: (_flow, executionId) => Effect.sync(() => void interruptCalls.push(executionId)),
        interruptUnsafe: () => Effect.void,
        resume: () => Effect.void,
        activityExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void })),
        deferredResult: () => Effect.succeedNone,
        deferredDone: () => Effect.void,
        scheduleClock: () => Effect.void
      })
      const parentInstance = FlowEngine.FlowInstance.initial(parentFlow, "parent-exec")
      parentInstance.interrupted = parentInterrupted

      return Effect.gen(function*() {
        // suspension interrupts the running fiber, so observe it from outside
        const fiber = yield* Effect.forkChild(
          scripted.execute(child, {
            executionId: "child-exec",
            payload: { n: 1 }
          }).pipe(Effect.scoped)
        )
        const exit = yield* Fiber.await(fiber)
        // a completed child yields its value; a suspended one suspends the parent
        expect(Exit.isSuccess(exit)).toBe(childOutcome === "Complete")
        expect(interruptCalls).toEqual(expected)
      }).pipe(
        Effect.provideService(FlowEngine.FlowInstance, parentInstance),
        Effect.provideService(FlowEngine.FlowEngine, scripted)
      )
    })
  }

  effect("a completed child is not interrupted when the parent is torn down", () => {
    const interrupted: Array<string> = []
    const child = Flow.make("Child/quick-child", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const parent = Flow.make("Child/quick-parent", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const layer = Layer.mergeAll(
      child.toLayer((payload) =>
        Effect.succeed(payload.n).pipe(
          Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("child")))
        )
      ),
      parent.toLayer(() => child.execute({ n: 5 }, { executionId: "child-quick" }))
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* parent.execute({ id: "x" }, { executionId: "parent-quick" })).toBe(5)
      expect(interrupted).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("resumeSignal", () => {
  effect("a wake signal races the suspended backoff sleep instead of waiting it out", () => {
    // A durable driver supplies `resumeSignal` so a wake (approval granted,
    // event delivered) resumes immediately rather than after the policy delay.
    // The delay here is an hour: only the signal can finish this test.
    const flow = Flow.make("Signal/waker", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({
        initialMs: 3_600_000,
        factor: 1,
        maxMs: 3_600_000
      })
    })
    let executions = 0
    let signals = 0
    const scripted = FlowEngine.makeUnsafe({
      register: () => Effect.void,
      execute: (() =>
        Effect.sync(() => {
          executions++
          return executions === 1
            ? new Flow.Suspended({})
            : new Flow.Complete({ exit: Exit.succeed("woken") })
        })) as any,
      poll: () => Effect.succeedNone,
      interrupt: () => Effect.void,
      interruptUnsafe: () => Effect.void,
      resume: () => Effect.void,
      resumeSignal: () => Effect.sync(() => void signals++),
      activityExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void })),
      deferredResult: () => Effect.succeedNone,
      deferredDone: () => Effect.void,
      scheduleClock: () => Effect.void
    })

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-signal" })).toBe("woken")
      expect(executions).toBe(2)
      expect(signals).toBe(1)
    }).pipe(Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(scripted)))
  })

  effect("without a resumeSignal the engine falls back to the policy delay", () => {
    const flow = Flow.make("Signal/no-waker", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 })
    })
    let executions = 0
    const scripted = FlowEngine.makeUnsafe({
      register: () => Effect.void,
      execute: (() =>
        Effect.sync(() => {
          executions++
          return executions === 1
            ? new Flow.Suspended({})
            : new Flow.Complete({ exit: Exit.succeed("slept") })
        })) as any,
      poll: () => Effect.succeedNone,
      interrupt: () => Effect.void,
      interruptUnsafe: () => Effect.void,
      resume: () => Effect.void,
      activityExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void })),
      deferredResult: () => Effect.succeedNone,
      deferredDone: () => Effect.void,
      scheduleClock: () => Effect.void
    })

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-nosignal" })).toBe("slept")
      expect(executions).toBe(2)
    }).pipe(Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(scripted)))
  })
})
