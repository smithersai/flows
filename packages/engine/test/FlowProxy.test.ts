import { Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { DurableDeferred, Flow, FlowEngine, FlowProxy } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))))

describe("FlowProxy", () => {
  const flow = Flow.make("FlowProxy/round-trip", {
    payload: { value: Schema.Number },
    success: Schema.Number,
    error: Schema.Literal("invalid"),
    idempotencyKey: ({ value }) => String(value)
  })

  effect("uses an envelope that forwards executionId for execute and discard", () =>
    Effect.gen(function*() {
      const group = FlowProxy.toRpcGroup([flow])
      const execute = group.requests.get("FlowProxy/round-trip")!
      const discard = group.requests.get("FlowProxy/round-tripDiscard")!
      const executePayload = execute.payloadSchema.make({
        payload: { value: 1 },
        executionId: "client-execution"
      })
      const discardPayload = discard.payloadSchema.make({
        payload: { value: 1 },
        executionId: "client-discard"
      })
      expect(executePayload).toMatchObject({ executionId: "client-execution", payload: { value: 1 } })
      expect(discardPayload).toMatchObject({ executionId: "client-discard", payload: { value: 1 } })
    }))

  effect("keeps schema-encoded exits typed at the proxy boundary", () =>
    Effect.gen(function*() {
      const group = FlowProxy.toRpcGroup([flow])
      const execute = group.requests.get("FlowProxy/round-trip")!
      const error = Schema.decodeUnknownSync(execute.errorSchema)("invalid")
      expect(error).toBe("invalid")
    }))

  effect("polling fallback wakes a suspended flow under TestClock", () => {
    const signal = DurableDeferred.make("FlowProxy/poll-signal", { success: Schema.Number })
    const suspended = Flow.make("FlowProxy/suspended", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = suspended.toLayer(() => DurableDeferred.await(signal)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const running = yield* suspended.execute({ id: "one" }, { executionId: "suspended" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      const result = yield* suspended.poll("suspended")
      expect(Option.isSome(result)).toBe(true)
      yield* Fiber.interrupt(running)
    }).pipe(Effect.provide(layer))
  })
})
