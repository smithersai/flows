import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { PersistedQueue } from "effect/unstable/persistence"
import { describe, expect, it } from "vitest"
import { DurableQueue, Workflow, WorkflowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const PersistedQueueLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

const pollUntilComplete = <A, E, R>(poll: Effect.Effect<Option.Option<Workflow.Result<A, E>>, never, R>) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 10 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 millis")
      result = yield* poll
    }
    return result
  })

describe("DurableQueue", () => {
  const Queue = DurableQueue.make({
    name: "DurableQueue/SuppliedKey",
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  const Workflow_ = Workflow.make("DurableQueue/SuppliedKey", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  const successLayer = Layer.mergeAll(
    Workflow_.toLayer(({ id, value }) => DurableQueue.process(Queue, { id, value })),
    DurableQueue.worker(Queue, ({ value }) => Effect.succeed(value + 1))
  ).pipe(
    Layer.provideMerge(WorkflowEngine.layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  effect("processes queued work through the supplied-key engine seam", () =>
    Effect.gen(function*() {
      const executionId = yield* Workflow_.execute({ id: "success", value: 41 }, { discard: true })
      const result = yield* pollUntilComplete(Workflow_.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(42)
      }
    }).pipe(Effect.provide(successLayer)))

  effect("propagates queue worker failures", () => {
    const Failure = Workflow.make("DurableQueue/Failure", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      Failure.toLayer(({ id }) => DurableQueue.process(Queue, { id, value: 0 }).pipe(Effect.asVoid)),
      DurableQueue.worker(Queue, () => Effect.fail("boom"))
    ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory), Layer.provideMerge(PersistedQueueLayer))

    return Effect.gen(function*() {
      const executionId = yield* Failure.execute({ id: "failure" }, { discard: true })
      const result = yield* pollUntilComplete(Failure.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })
})
