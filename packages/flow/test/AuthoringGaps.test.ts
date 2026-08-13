// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The authoring-surface corners the behavioural suites do not reach: the
 * cache-environment filter, the context references' defaults, the internal
 * idempotency-key scoping forms, infrastructure-interrupt exhaustion, the
 * flow scope helpers, and the waiting annotation a durable driver reads.
 */
import { Activity, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow-next"
import { Cause, Context, Effect, Exit, Layer, Option, Schedule, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

/** The one step the host flow is made of; each case supplies its body. */
const Block = Activity.make("Gaps/Block", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const Host = Flow.make("Gaps/Host", {
  payload: { id: Schema.String },
  success: Schema.Void,
  idempotencyKey: ({ id }) => id,
  body: (payload) => Block.call(payload)
})

/** The host flow, wired to run `execute` as its single declared step. */
const hosted = (
  execute: () => Effect.Effect<void, never, FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): Layer.Layer<FlowRuntime.FlowRuntime | Activity.Implementations> =>
  layerWired(Layer.mergeAll(Block.toLayer(execute), Interpreter.layer(Host)))

describe("Activity.CacheEnvironment", () => {
  it("accepts a complete environment and rejects an empty capability name", () => {
    const decode = Schema.decodeUnknownExit(Activity.CacheEnvironment)
    expect(
      Exit.isSuccess(decode({ layers: ["node@22"], capabilities: { net: ["dns"] } }))
    ).toBe(true)
    expect(
      Exit.isFailure(decode({ layers: ["node@22"], capabilities: { "": ["dns"] } }))
    ).toBe(true)
  })

  effect("layerCacheEnvironment publishes it, and the reference defaults to absent", () =>
    Effect.gen(function*() {
      expect(yield* Activity.CurrentCacheEnvironment).toBeUndefined()
      expect(yield* Activity.CurrentOrdinal).toBeUndefined()
      expect(yield* Activity.CurrentAttempt).toBe(1)
      const environment: Activity.CacheEnvironment = {
        layers: ["node@22"],
        capabilities: { net: ["dns"] }
      }
      const seen = yield* Activity.CurrentCacheEnvironment.pipe(
        Effect.provide(Activity.layerCacheEnvironment(environment))
      )
      expect(seen).toEqual(environment)
    }))
})

describe("Activity.idempotencyKey", () => {
  const withInstance = <A, E>(effect: Effect.Effect<A, E, FlowRuntime.FlowInstance | Crypto.Crypto>) =>
    Effect.provideService(effect, FlowRuntime.FlowInstance, makeInstance(Host, "internal-keys"))

  effect(
    "scopes allocations by the declared parent, the attempt, or neither",
    () =>
      withInstance(Effect.gen(function*() {
        const plain = yield* Activity.idempotencyKey("offer")
        const alsoPlain = yield* Activity.idempotencyKey("offer")
        const scoped = yield* Activity.idempotencyKey("offer", { parentScope: "queue:a" })
        const byAttempt = yield* Activity.idempotencyKey("offer", { includeAttempt: true })
        // Distinct allocations of one scope are ordinal-ordered, and distinct
        // scopes never collide.
        expect(plain).not.toBe(alsoPlain)
        expect(new Set([plain, alsoPlain, scoped, byAttempt]).size).toBe(4)
      }))
  )
})

describe("Activity infrastructure-interrupt retry", () => {
  effect("exhausting the interrupt policy dies rather than failing", () => {
    let attempts = 0
    const activity = Activity.make({
      name: "Gaps/infra",
      success: Schema.Void,
      error: Schema.Union([Activity.InfraInterrupt, Schema.String]),
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Activity.InfraInterrupt({ reason: "host lost" }))
      })
    })
    const layer = hosted(() => Effect.asVoid(activity).pipe(Effect.orDie))
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "infra" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("infrastructure interrupt retry attempts exhausted")
      expect(attempts).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  effect("a non-infrastructure failure is propagated untouched", () => {
    const activity = Activity.make({
      name: "Gaps/other",
      success: Schema.Void,
      error: Schema.String,
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.fail("plain")
    })
    const layer = hosted(() => Effect.asVoid(activity).pipe(Effect.orDie))
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "other" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("plain")
    }).pipe(Effect.provide(layer))
  })
})

describe("flow scope helpers", () => {
  effect("scope and provideScope expose the flow lifetime scope", () => {
    let finalized = 0
    const layer = hosted(() =>
      Effect.gen(function*() {
        const flowScope = yield* Flow.scope
        expect(flowScope).toBeDefined()
        yield* Flow.provideScope(
          Effect.flatMap(
            Effect.scope,
            (scope) => Scope.addFinalizer(scope, Effect.sync(() => void finalized++))
          )
        )
        // the scope outlives the step that registered on it: nothing has run yet
        expect(finalized).toBe(0)
      })
    )
    return Effect.gen(function*() {
      yield* Host.execute({ id: "scope" })
      expect(finalized).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("Flow annotations", () => {
  effect("annotateMerge folds a context into the flow definition, and an uncaptured defect escapes", () => {
    const Defective = Activity.make("Gaps/Uncaptured/step", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const Uncaptured = Flow.make("Gaps/Uncaptured", {
      payload: { id: Schema.String },
      success: Schema.Void,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Defective.call(payload)
    }).annotateMerge(Context.make(Flow.CaptureDefects, false))
    expect(Uncaptured._tag).toBe("Gaps/Uncaptured")
    const layer = layerWired(
      Layer.mergeAll(Defective.toLayer(() => Effect.die("boom")), Interpreter.layer(Uncaptured))
    )
    return Effect.gen(function*() {
      const exit = yield* Uncaptured.execute({ id: "defect" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})

describe("DurableDeferred.into", () => {
  effect("strips interrupt reasons from a mixed cause before recording it", () => {
    const gate = DurableDeferred.make("Gaps/mixed", { error: Schema.String })
    const layer = hosted(() =>
      DurableDeferred.into(
        Effect.failCause(
          Cause.combine(Cause.fail("real"), Cause.interrupt(1))
        ) as Effect.Effect<void, string>,
        gate
      ).pipe(Effect.orDie)
    )
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "mixed" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("real")
    }).pipe(Effect.provide(layer))
  })

  effect("a plain failure is recorded verbatim", () => {
    const gate = DurableDeferred.make("Gaps/plain", { error: Schema.String })
    const layer = hosted(() =>
      DurableDeferred.into(Effect.fail("just failed") as Effect.Effect<void, string>, gate).pipe(
        Effect.orDie
      )
    )
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "plain-fail" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("just failed")
    }).pipe(Effect.provide(layer))
  })

  effect("an interrupt-only cause without a suspension is still recorded", () => {
    const gate = DurableDeferred.make("Gaps/interrupted", { error: Schema.String })
    const layer = hosted(() =>
      DurableDeferred.into(Effect.interrupt as Effect.Effect<void, string>, gate).pipe(
        Effect.orDie
      )
    )
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "interrupted" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})

describe("FlowRuntime.annotateWaiting", () => {
  effect("records the declared classification on the instance", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "waiting")
      yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "req-1" }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(instance.waiting).toEqual({ reason: "approval", token: "req-1" })
      yield* FlowRuntime.annotateWaiting(undefined).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(instance.waiting).toBeUndefined()
    }))

  it("FlowCycleDetected carries its stable code and path", () => {
    const error = new FlowRuntime.FlowCycleDetected({
      code: "flow_cycle_detected",
      path: ["a", "b"]
    })
    expect(error.code).toBe("flow_cycle_detected")
    expect(error.path).toEqual(["a", "b"])
    expect(Option.isSome(Option.some(error))).toBe(true)
  })
})
