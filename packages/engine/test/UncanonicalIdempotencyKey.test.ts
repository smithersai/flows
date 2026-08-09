/**
 * Issue #151: `Result.getOrThrow(StepKey.content|ordinal(...))` at the four
 * key-derivation sites turned a typed `CanonicalError` — produced by
 * perfectly ordinary caller values in a `ContentIdentity` (a `Date`,
 * `undefined`, a class instance, a `Redacted`) — into an untyped defect that
 * killed the fiber. The caller-owned sites now surface a typed, non-retryable
 * `Activity.UncanonicalIdempotencyKey` naming the offending path (delivered
 * through the recorded completion exit, the same channel RetryPolicy's
 * typed terminal errors use), and the engine-generated ordinal sites go
 * through `StepIdentity.ordinalKey`, which preserves the typed error for the
 * impossible invariant violation instead of discarding it.
 */
import { StepKey } from "@smthrs/keys"
import { Cause, Effect, Exit, Layer, Redacted, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"
import * as StepIdentity from "../src/StepIdentity.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const identityWith = (body: unknown): StepKey.ContentIdentity => ({
  body,
  inputs: {},
  layers: [],
  capabilities: {}
})

const dieOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isDieReason)
  return reason?.defect
}

const runRejected = (tier: "sealed" | "compensable", body: unknown) => {
  let executions = 0
  const activity = Activity.make({
    name: `Uncanonical/${tier}`,
    success: Schema.Number,
    tier,
    idempotencyKey: identityWith(body),
    execute: Effect.sync(() => {
      executions++
      return 1
    })
  })
  const flow = Flow.make(`Uncanonical/${tier}-flow`, {
    payload: { id: Schema.String },
    success: Schema.Number
  })
  const layer = flow.toLayer(() => activity).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  return Effect.gen(function*() {
    const exit = yield* flow.execute({ id: "x" }, { executionId: `run-${tier}` }).pipe(Effect.exit)
    return { exit, executions }
  }).pipe(Effect.provide(layer))
}

describe("rejected declaration material surfaces typed, not as fiber death (issue #151)", () => {
  effect("a Date in a sealed ContentIdentity fails typed, naming the offending path", () =>
    Effect.gen(function*() {
      const outcome = yield* runRejected("sealed", { when: new Date(0) })
      const defect = dieOf(outcome.exit)
      expect(defect).toBeInstanceOf(Activity.UncanonicalIdempotencyKey)
      const error = defect as Activity.UncanonicalIdempotencyKey
      expect(error.code).toBe("uncanonical_idempotency_key")
      expect(error.activityName).toBe("Uncanonical/sealed")
      expect(error.reason).toBe("class_instance")
      expect(error.path).toContain("when")
      // Non-retryable: the body never ran.
      expect(outcome.executions).toBe(0)
    }))

  effect("undefined in a sealed ContentIdentity fails typed with unsupported_type", () =>
    Effect.gen(function*() {
      const outcome = yield* runRejected("sealed", { flag: undefined })
      const error = dieOf(outcome.exit) as Activity.UncanonicalIdempotencyKey
      expect(error).toBeInstanceOf(Activity.UncanonicalIdempotencyKey)
      expect(error.reason).toBe("unsupported_type")
      expect(error.path).toContain("flag")
      expect(outcome.executions).toBe(0)
    }))

  effect("a Redacted value in a sealed ContentIdentity fails typed with redacted", () =>
    Effect.gen(function*() {
      const outcome = yield* runRejected("sealed", { secret: Redacted.make("token") })
      const error = dieOf(outcome.exit) as Activity.UncanonicalIdempotencyKey
      expect(error).toBeInstanceOf(Activity.UncanonicalIdempotencyKey)
      expect(error.reason).toBe("redacted")
      expect(outcome.executions).toBe(0)
    }))

  effect(
    "a rejected ContentIdentity on a non-sealed tier fails typed at the ordinal-scope site",
    () =>
      Effect.gen(function*() {
        const outcome = yield* runRejected("compensable", { when: new Date(0) })
        const error = dieOf(outcome.exit) as Activity.UncanonicalIdempotencyKey
        expect(error).toBeInstanceOf(Activity.UncanonicalIdempotencyKey)
        expect(error.activityName).toBe("Uncanonical/compensable")
        expect(error.reason).toBe("class_instance")
        expect(outcome.executions).toBe(0)
      })
  )
})

describe("StepIdentity typed derivations (issue #151)", () => {
  it("allocationScope returns the typed CanonicalError for rejected object material", () => {
    const scope = StepIdentity.allocationScope({
      kind: "activity",
      name: "op",
      idempotency: identityWith({ when: new Date(0) })
    })
    expect(Result.isFailure(scope)).toBe(true)
    if (Result.isFailure(scope)) {
      expect(scope.failure.code).toBe("class_instance")
      expect(scope.failure.path).toContain("when")
    }
  })

  it("allocationScope stays total for string and absent idempotency material", () => {
    const keyless = StepIdentity.allocationScope({ kind: "internal", name: "op" })
    const keyed = StepIdentity.allocationScope({ kind: "internal", name: "op", idempotency: "queue:orders" })
    expect(Result.getOrThrow(keyless)).toBe("internal/2:op")
    expect(Result.getOrThrow(keyed)).toMatch(/^internal\/2:op\/s:/)
  })

  it("ordinalKey preserves the typed CanonicalError on the impossible invariant violation", () => {
    expect(() =>
      StepIdentity.ordinalKey({
        runId: "run",
        ordinal: Number.POSITIVE_INFINITY,
        tier: "unsealed"
      })
    ).toThrowError(expect.objectContaining({ code: "non_finite_number" }))
    expect(StepIdentity.ordinalKey({ runId: "run", ordinal: 1, tier: "unsealed" })).toBe(
      Result.getOrThrow(StepKey.ordinal({ runId: "run", ordinal: 1, tier: "unsealed" }))
    )
  })
})
