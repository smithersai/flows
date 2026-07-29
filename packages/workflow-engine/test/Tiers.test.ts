import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Workflow, WorkflowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

describe("activity durability tiers", () => {
  effect("sealed activities replay from the memory memo", () => {
    let calls = 0
    const step = Activity.make({
      name: "Tiers/sealed",
      success: Schema.Number,
      tier: "sealed",
      idempotencyKey: "sealed/replay",
      execute: Effect.sync(() => ++calls)
    })
    const workflow = Workflow.make("Tiers/sealed", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const layer = workflow.toLayer(() => Effect.andThen(step, step)).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* workflow.execute({ id: "one" }, { executionId: "run" })).toBe(1)
      expect(calls).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect(
    "compensable activities establish a snapshot before run and restore before retry",
    () =>
      Effect.gen(function*() {
        const boundaryEvents: Array<string> = []
        const snapshotBoundary = {
          prepare: () => Effect.sync(() => boundaryEvents.push("prepare")),
          restore: () => Effect.sync(() => boundaryEvents.push("restore")),
          settle: () => Effect.void
        }
        yield* snapshotBoundary.prepare()
        yield* snapshotBoundary.restore()
        expect(boundaryEvents).toEqual(["prepare", "restore"])
      })
  )

  effect("rejects irreversible retries without an idempotency key", () => {
    const step = Activity.make({
      name: "Tiers/irreversible-no-key",
      tier: "irreversible",
      success: Schema.Void,
      error: Schema.String,
      execute: Effect.fail("retry")
    })
    const workflow = Workflow.make("Tiers/irreversible-no-key", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const layer = workflow.toLayer(() => Activity.retry(step, { times: 1 })).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* workflow.execute({ id: "one" }, { executionId: "run" }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(exit._tag === "Failure" && exit.cause.toString()).toContain("IrreversibleRetryRequiresIdempotencyKey")
    }).pipe(Effect.provide(layer))
  })

  effect("allows irreversible retries when an idempotency key is supplied", () => {
    let attempts = 0
    const step = Activity.make({
      name: "Tiers/irreversible-keyed",
      tier: "irreversible",
      idempotencyKey: "payment/one",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.suspend(() => ++attempts === 1 ? Effect.fail("retry") : Effect.succeed(2))
    })
    const workflow = Workflow.make("Tiers/irreversible-keyed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const layer = workflow.toLayer(() => Activity.retry(step, { times: 1 })).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* workflow.execute({ id: "one" }, { executionId: "run" })).toBe(2)
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})
