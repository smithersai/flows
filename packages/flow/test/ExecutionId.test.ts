// Deep reviewed and polished by a human on 2026-08-10.

import { Activity, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

describe("Flow execution identities", () => {
  const Echo = Activity.make("ExecutionId/echo", {
    payload: { value: Schema.String },
    success: Schema.String
  })

  const Idempotent = Flow.make("ExecutionId/Idempotent", {
    payload: { value: Schema.String },
    success: Schema.String,
    idempotencyKey: ({ value }) => `key:${value}`,
    body: ({ value }) => Echo.call({ value })
  })

  const IdempotentLayer = layerWired(
    Layer.mergeAll(
      Echo.toLayer(({ value }) => Effect.succeed(value)),
      Interpreter.layer(Idempotent)
    )
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
    const Unreached = Activity.make("ExecutionId/unreached", {
      payload: { value: Schema.String },
      success: Schema.String
    })
    const Missing = Flow.make("ExecutionId/Missing", {
      payload: { value: Schema.String },
      success: Schema.String,
      body: ({ value }) => Unreached.call({ value })
    })
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Unreached.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Missing)
      )
    )

    return Effect.gen(function*() {
      const exit = yield* Missing.execute({ value: "never" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(invoked).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})
