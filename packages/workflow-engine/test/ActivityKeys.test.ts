import { StepKey } from "@flows/keys"
import { Effect, Exit, Layer, Result, Schedule, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Workflow, WorkflowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

describe("activity execution keys", () => {
  effect("replays a caller-supplied sealed key even when the activity is renamed", () => {
    let executions = 0
    const first = Activity.make({
      name: "ActivityKeys/first-name",
      success: Schema.Number,
      idempotencyKey: "sealed/caller-key",
      execute: Effect.sync(() => ++executions)
    })
    const renamed = Activity.make({
      name: "ActivityKeys/renamed",
      success: Schema.Number,
      idempotencyKey: "sealed/caller-key",
      execute: Effect.sync(() => ++executions)
    })
    const workflow = Workflow.make("ActivityKeys/replay", {
      payload: { run: Schema.String },
      success: Schema.Number
    })
    const layer = workflow.toLayer(() => Effect.andThen(first, renamed)).pipe(
      Layer.provideMerge(WorkflowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* workflow.execute({ run: "one" }, { executionId: "run-one" })).toBe(1)
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
