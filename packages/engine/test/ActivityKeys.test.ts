import { StepKey } from "@smithers/keys"
import { Effect, Exit, Layer, Result, Schedule, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

describe("activity execution keys", () => {
  effect("namespaces string idempotency keys by activity name so distinct activities never collide", () => {
    // Issue #9: `chargeCard` and `sendEmail` both declaring
    // `idempotencyKey: "order-123"` must NOT share a step key — otherwise the
    // second replays the first's persisted outcome against the wrong schema.
    let charges = 0
    let emails = 0
    const chargeCard = Activity.make({
      name: "ActivityKeys/chargeCard",
      success: Schema.Number,
      idempotencyKey: "order-123",
      execute: Effect.sync(() => {
        charges++
        return 42
      })
    })
    const sendEmail = Activity.make({
      name: "ActivityKeys/sendEmail",
      success: Schema.String,
      idempotencyKey: "order-123",
      execute: Effect.sync(() => {
        emails++
        return "sent"
      })
    })
    const flow = Flow.make("ActivityKeys/no-collision", {
      payload: { run: Schema.String },
      success: Schema.String
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const amount = yield* chargeCard
        const receipt = yield* sendEmail
        return `${amount}:${receipt}`
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe("42:sent")
      expect(charges).toBe(1)
      expect(emails).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("replays the same activity's string idempotency key across attempts", () => {
    let executions = 0
    const activity = () =>
      Activity.make({
        name: "ActivityKeys/stable",
        success: Schema.Number,
        idempotencyKey: "sealed/caller-key",
        execute: Effect.sync(() => ++executions)
      })
    const flow = Flow.make("ActivityKeys/replay", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() => Effect.andThen(activity(), activity())).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("keeps an explicit ContentIdentity caller-owned so replay survives an activity rename", () => {
    // The object-form idempotencyKey is the escape hatch for rename-stable
    // identity: the caller owns the full key material, so the activity name
    // intentionally does not enter the digest.
    let executions = 0
    const identity = {
      body: "sealed/caller-owned",
      inputs: {},
      layers: [],
      capabilities: {}
    }
    const first = Activity.make({
      name: "ActivityKeys/first-name",
      success: Schema.Number,
      idempotencyKey: identity,
      execute: Effect.sync(() => ++executions)
    })
    const renamed = Activity.make({
      name: "ActivityKeys/renamed",
      success: Schema.Number,
      idempotencyKey: identity,
      execute: Effect.sync(() => ++executions)
    })
    const flow = Flow.make("ActivityKeys/rename-stable", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = flow.toLayer(() => Effect.andThen(first, renamed)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* flow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("changes sealed replay identity when its input, layer, or capability material changes", () => {
    const keyFor = (input: string, layer: string, capability: string) =>
      Result.getOrThrow(StepKey.content({
        body: "activity",
        inputs: { input },
        layers: [layer],
        capabilities: { declared: [capability] }
      }))
    const first = keyFor("input-a", "layer-a", "capability-a")
    const changedInput = keyFor("input-b", "layer-a", "capability-a")
    const changedLayer = keyFor("input-a", "layer-b", "capability-a")
    const changedCapability = keyFor("input-a", "layer-a", "capability-b")

    return Effect.gen(function*() {
      expect(first).not.toBe(changedInput)
      expect(first).not.toBe(changedLayer)
      expect(first).not.toBe(changedCapability)
    })
  })

  effect("keeps ordinal activity keys isolated by run and never by activity name", () =>
    Effect.gen(function*() {
      const ordinal = (run: string, attempt: number) => `ordinal/${run}/compensable/${attempt}`
      expect(ordinal("run-a", 1)).not.toBe(ordinal("run-b", 1))
      expect(ordinal("run-a", 1)).not.toBe(ordinal("run-a", 2))
      expect(ordinal("run-a", 1)).not.toContain("activity-name")
    }))

  effect("classifies tagged infrastructure interrupts for retry exhaustion", () => {
    const activity = Activity.make({
      name: "ActivityKeys/infra-interrupt",
      error: Schema.Unknown,
      interruptRetryPolicy: Schedule.recurs(0),
      execute: Effect.fail(new Activity.InfraInterrupt({ reason: "host-lost" }))
    })

    return Effect.gen(function*() {
      const exit = yield* activity.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
    })
  })
})
