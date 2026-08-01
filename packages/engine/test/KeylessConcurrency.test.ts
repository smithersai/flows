/**
 * Issue #111: keyless same-declaration activities dispatched concurrently
 * take their ordinals from fiber arrival order, so a crash-resume that
 * replays the fibers in the opposite order silently hands one invocation the
 * other's recorded outcome — with no input material persisted, the swap is
 * undetectable after the fact. Temporal fails such replays with a
 * nondeterminism error; the engine refuses the hazard on the first run
 * instead: a second in-flight keyless dispatch of one allocation scope dies
 * with `ConcurrentKeylessDispatch`, and declaring an `idempotencyKey` is the
 * sanctioned way to run distinguishable invocations concurrently.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const flow = Flow.make("KeylessConcurrency/flow", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const keylessFetch = Activity.make({
  name: "KeylessConcurrency/fetch",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const keyedFetch = (idempotencyKey: string) =>
  Activity.make({
    name: "KeylessConcurrency/fetch",
    tier: "irreversible",
    idempotencyKey,
    success: Schema.Void,
    execute: Effect.void
  })

/**
 * An engine whose dispatch parks on `gate`, so two dispatches genuinely
 * overlap instead of the first completing synchronously before the second
 * starts.
 */
const gatedEngine = (gate: Deferred.Deferred<void>) =>
  FlowEngine.makeUnsafe({
    register: () => Effect.void,
    execute: () => Effect.die("not used"),
    poll: () => Effect.succeedNone,
    interrupt: () => Effect.void,
    interruptUnsafe: () => Effect.void,
    resume: () => Effect.void,
    activityExecute: () =>
      Effect.as(Deferred.await(gate), new Flow.Complete({ exit: Exit.void })),
    deferredResult: () => Effect.succeedNone,
    deferredDone: () => Effect.void,
    scheduleClock: () => Effect.void
  })

const drive = (
  executionId: string,
  program: (engine: FlowEngine.FlowEngine["Service"], gate: Deferred.Deferred<void>) => Effect.Effect<unknown>
) =>
  Effect.gen(function*() {
    const gate = yield* Deferred.make<void>()
    const engine = gatedEngine(gate)
    return yield* program(engine, gate).pipe(
      Effect.provideService(
        FlowEngine.FlowInstance,
        FlowEngine.FlowInstance.initial(flow, executionId)
      ),
      Effect.provide(Layer.succeed(FlowEngine.FlowEngine)(engine)),
      Effect.exit
    )
  })

const dies = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some((reason) =>
    Cause.isDieReason(reason) &&
    reason.defect instanceof Activity.ConcurrentKeylessDispatch &&
    reason.defect.activityName === "KeylessConcurrency/fetch"
  )

describe("concurrent keyless same-declaration dispatches are refused (issue #111)", () => {
  effect("two overlapping keyless dispatches of one declaration die loudly", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyless-overlap", (engine, gate) =>
        Effect.all([
          engine.activityExecute(keylessFetch as never, 1),
          // The second dispatch arrives while the first is still parked in
          // the gated body — the exact window in which a replay could
          // reverse arrival order and swap the recorded outcomes.
          engine.activityExecute(keylessFetch as never, 1).pipe(
            Effect.ensuring(Deferred.done(gate, Exit.void))
          )
        ], { concurrency: "unbounded" }))
      expect(dies(exit)).toBe(true)
    })
  })

  effect("declared idempotency keys make the same pair safe to overlap", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyed-overlap", (engine, gate) =>
        Effect.gen(function*() {
          // Fork both dispatches so they genuinely overlap in the gated
          // body, then release the gate from outside.
          const fiber = yield* Effect.forkChild(Effect.all([
            engine.activityExecute(keyedFetch("url-a") as never, 1),
            engine.activityExecute(keyedFetch("url-b") as never, 1)
          ], { concurrency: "unbounded" }))
          yield* Effect.yieldNow
          yield* Deferred.done(gate, Exit.void)
          yield* Fiber.join(fiber)
        }))
      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })

  effect("sequential keyless dispatches of one declaration stay allowed", () => {
    return Effect.gen(function*() {
      const exit = yield* drive("keyless-sequential", (engine, gate) =>
        Effect.gen(function*() {
          yield* Deferred.done(gate, Exit.void)
          yield* engine.activityExecute(keylessFetch as never, 1)
          yield* engine.activityExecute(keylessFetch as never, 1)
        }))
      expect(Exit.isSuccess(exit)).toBe(true)
    })
  })
})
