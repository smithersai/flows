import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Workflow, WorkflowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

describe("Workflow execution identities", () => {
  const Idempotent = Workflow.make("ExecutionId/Idempotent", {
    payload: { value: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ value }) => `key:${value}`
  })

  const IdempotentLayer = Idempotent.toLayer(({ value }) => Effect.succeed(value)).pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory)
  )

  effect("an explicit execution id wins over the idempotency key", () =>
    Effect.gen(function*() {
      const executionId = yield* Idempotent.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(IdempotentLayer)))

  effect("derives a stable deterministic id from an opt-in idempotency key", () =>
    Effect.gen(function*() {
      const first = yield* Idempotent.executionId({ value: "stable" })
      const second = yield* Idempotent.executionId({ value: "stable" })
      const other = yield* Idempotent.executionId({ value: "other" })
      expect(first).toBe(second)
      expect(first).not.toBe(other)
    }))

  effect("dies before engine invocation when neither identity source is supplied", () => {
    const Missing = Workflow.make("ExecutionId/Missing", {
      payload: { value: Schema.String },
      success: Schema.String
    })
    let invoked = 0
    const layer = Missing.toLayer(({ value }) =>
      Effect.sync(() => {
        invoked++
        return value
      })
    ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory))

    return Effect.gen(function*() {
      const exit = yield* Missing.execute({ value: "never" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(invoked).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})
