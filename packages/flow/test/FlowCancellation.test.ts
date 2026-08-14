import { Flow, FlowRuntime } from "@smthrs/flow-next"
import { Node } from "@smthrs/plan-next"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const TestFlow = Flow.make("Cancellation/test", {
  payload: {},
  body: () => Node.succeed(undefined)
})

const failure = new FlowRuntime.CancelRequestFailed({
  code: "cancel_request_failed",
  executionId: "cancellation-1",
  reason: "journal unavailable"
})

const layerFailingCancellation = Layer.effect(
  FlowRuntime.FlowRuntime,
  Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
    FlowRuntime.FlowRuntime.of({
      ...runtime,
      interrupt: () => Effect.fail(failure),
      interruptUnsafe: () => Effect.fail(failure)
    }))
).pipe(Layer.provide(layerMemory))

describe("Flow cancellation failures", () => {
  it("Flow.interrupt forwards CancelRequestFailed unchanged", async () => {
    const observed = await runPromise(
      Effect.flip(TestFlow.interrupt("cancellation-1")).pipe(Effect.provide(layerFailingCancellation))
    )

    expect(observed).toBe(failure)
    expect(observed).toMatchObject({
      _tag: "flows/engine/CancelRequestFailed",
      code: "cancel_request_failed",
      executionId: "cancellation-1",
      reason: "journal unavailable"
    })
  })

  it("FlowRuntime.interruptUnsafe forwards the equivalent CancelRequestFailed unchanged", async () => {
    const observed = await runPromise(
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        return yield* Effect.flip(runtime.interruptUnsafe(TestFlow, "cancellation-1"))
      }).pipe(Effect.provide(layerFailingCancellation))
    )

    expect(observed).toBe(failure)
    expect(observed).toMatchObject({
      _tag: "flows/engine/CancelRequestFailed",
      code: "cancel_request_failed",
      executionId: "cancellation-1",
      reason: "journal unavailable"
    })
  })
})
