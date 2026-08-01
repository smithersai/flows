import { StepKey } from "@smithers/keys"
import { Cause, Effect, Exit, Layer, Result, Schedule, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const ordinalKey = (runId: string, ordinal: number, parentScope?: string) =>
  Result.getOrThrow(StepKey.ordinal({
    runId,
    ordinal,
    tier: "unsealed",
    ...(parentScope === undefined ? {} : { parentScope })
  }))

describe("Activity.idempotencyKey scoping", () => {
  effect("allocates run-local ordinals and never folds the diagnostic name into identity", () => {
    const flow = Flow.make("IdentityGaps/ordinals", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String)
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const first = yield* Activity.idempotencyKey("first-name")
        const second = yield* Activity.idempotencyKey("second-name")
        return [first, second] as const
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const [first, second] = yield* flow.execute({ id: "x" }, { executionId: "run-ordinals" })
      expect(first).not.toBe(second)
      // the name is diagnostic only: identity is (runId, ordinal, tier)
      expect(first).toBe(ordinalKey("run-ordinals", 1))
      expect(second).toBe(ordinalKey("run-ordinals", 2))
    }).pipe(Effect.provide(layer))
  })

  effect("scopes the key by the current attempt only when includeAttempt is set", () => {
    const flow = Flow.make("IdentityGaps/include-attempt", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String)
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const plain = yield* Activity.idempotencyKey("op")
        const scoped = yield* Activity.idempotencyKey("op", { includeAttempt: true })
        const off = yield* Activity.idempotencyKey("op", { includeAttempt: false })
        return [plain, scoped, off] as const
      }).pipe(Effect.provideService(Activity.CurrentAttempt, 7))
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const [plain, scoped, off] = yield* flow.execute({ id: "x" }, { executionId: "run-attempt" })
      expect(plain).toBe(ordinalKey("run-attempt", 1))
      expect(scoped).toBe(ordinalKey("run-attempt", 2, "attempt:7"))
      // includeAttempt: false is identical in shape to omitting the option
      expect(off).toBe(ordinalKey("run-attempt", 3))
    }).pipe(Effect.provide(layer))
  })

  effect("an explicit parentScope wins over includeAttempt", () => {
    const flow = Flow.make("IdentityGaps/parent-scope", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const layer = flow.toLayer(() =>
      Activity.idempotencyKey("op", { parentScope: "queue:orders", includeAttempt: true }).pipe(
        Effect.provideService(Activity.CurrentAttempt, 4)
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const key = yield* flow.execute({ id: "x" }, { executionId: "run-scope" })
      expect(key).toBe(ordinalKey("run-scope", 1, "queue:orders"))
      expect(key).not.toBe(ordinalKey("run-scope", 1, "attempt:4"))
    }).pipe(Effect.provide(layer))
  })

  effect("keys allocated under the same attempt scope stay distinct per ordinal", () => {
    const flow = Flow.make("IdentityGaps/same-scope", {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String)
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const a = yield* Activity.idempotencyKey("op", { includeAttempt: true })
        const b = yield* Activity.idempotencyKey("op", { includeAttempt: true })
        return [a, b] as const
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const [a, b] = yield* flow.execute({ id: "x" }, { executionId: "run-same" })
      expect(a).not.toBe(b)
      // CurrentAttempt defaults to 1 when nothing provides it
      expect(a).toBe(ordinalKey("run-same", 1, "attempt:1"))
      expect(b).toBe(ordinalKey("run-same", 2, "attempt:1"))
    }).pipe(Effect.provide(layer))
  })
})

describe("infrastructure interrupt retry", () => {
  effect("passes a non-infrastructure failure through untouched instead of dying", () => {
    // The `while: isInfraInterrupt` retry wrapper must not convert an ordinary
    // typed failure into a defect just because a policy is installed.
    let attempts = 0
    const activity = Activity.make({
      name: "IdentityGaps/typed-failure",
      error: Schema.String,
      interruptRetryPolicy: Schedule.recurs(3),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("business-error")
      })
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("business-error")
      // a typed failure is never retried by the infra-interrupt policy
      expect(attempts).toBe(1)
    })
  })

  effect("retries an infrastructure interrupt until the policy is exhausted, then dies", () => {
    let attempts = 0
    const activity = Activity.make({
      name: "IdentityGaps/infra-exhausted",
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
      })
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        "infrastructure interrupt retry attempts exhausted"
      )
      // initial attempt + 2 recurrences
      expect(attempts).toBe(3)
    })
  })

  effect("recovers when a retried infrastructure interrupt later succeeds", () => {
    let attempts = 0
    const activity = Activity.make({
      name: "IdentityGaps/infra-recovers",
      success: Schema.Number,
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(5),
      execute: Effect.suspend(() => {
        attempts++
        return attempts < 3
          ? Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
          : Effect.succeed(attempts)
      })
    })

    return Effect.gen(function*() {
      expect(yield* activity.execute).toBe(3)
    })
  })

  effect("without a policy an infrastructure interrupt surfaces as its own typed failure", () => {
    const activity = Activity.make({
      name: "IdentityGaps/infra-unpolicied",
      error: Schema.Unknown,
      execute: Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(
        Exit.isFailure(exit) && (Cause.squash(exit.cause) as Activity.InfraInterrupt)._tag
      ).toBe("@smithers/engine/InfraInterrupt")
    })
  })
})
