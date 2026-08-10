// Deep reviewed and polished by a human on 2026-08-10.

import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { PersistedQueue } from "effect/unstable/persistence"
import { describe, expect, it } from "vitest"
import { DurableQueue, Flow, FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const PersistedQueueLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

const pollUntilComplete = <A, E, R>(poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>) =>
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
  const Flow_ = Flow.make("DurableQueue/SuppliedKey", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  const successLayer = Layer.mergeAll(
    Flow_.toLayer(({ id, value }) => DurableQueue.process(Queue, { id, value })),
    DurableQueue.worker(Queue, ({ value }) => Effect.succeed(value + 1))
  ).pipe(
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  effect("processes queued work through the supplied-key engine seam", () =>
    Effect.gen(function*() {
      const executionId = yield* Flow_.execute({ id: "success", value: 41 }, { discard: true })
      const result = yield* pollUntilComplete(Flow_.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(42)
      }
    }).pipe(Effect.provide(successLayer)))

  effect("propagates queue worker failures", () => {
    const Failure = Flow.make("DurableQueue/Failure", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      Failure.toLayer(({ id }) => DurableQueue.process(Queue, { id, value: 0 }).pipe(Effect.asVoid)),
      DurableQueue.worker(Queue, () => Effect.fail("boom"))
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(PersistedQueueLayer))

    return Effect.gen(function*() {
      const executionId = yield* Failure.execute({ id: "failure" }, { discard: true })
      const result = yield* pollUntilComplete(Failure.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("accepts an already-built payload schema as well as a field record", () => {
    // `make` adopts a schema as-is and wraps a field record; both forms must
    // round-trip an item through a worker identically.
    const payloadSchema = Schema.Struct({ id: Schema.String, value: Schema.Number })
    const SchemaQueue = DurableQueue.make({
      name: "DurableQueue/SchemaPayload",
      payload: payloadSchema,
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    expect(SchemaQueue.payloadSchema).toBe(payloadSchema)

    const SchemaFlow = Flow.make("DurableQueue/SchemaPayload", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = Layer.mergeAll(
      SchemaFlow.toLayer(({ id, value }) => DurableQueue.process(SchemaQueue, { id, value })),
      DurableQueue.worker(SchemaQueue, ({ value }) => Effect.succeed(value * 2))
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(PersistedQueueLayer))

    return Effect.gen(function*() {
      const executionId = yield* SchemaFlow.execute({ id: "schema", value: 21 }, { discard: true })
      const result = yield* pollUntilComplete(SchemaFlow.poll(executionId))
      expect(
        Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit) &&
          result.value.exit.value
      ).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  effect("a worker with concurrency 0 starts no workers, so queued items are never consumed", () => {
    const IdleQueue = DurableQueue.make({
      name: "DurableQueue/Idle",
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const IdleFlow = Flow.make("DurableQueue/Idle", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    let handled = 0
    const layer = Layer.mergeAll(
      IdleFlow.toLayer(({ id }) => DurableQueue.process(IdleQueue, { id }).pipe(Effect.asVoid)),
      DurableQueue.worker(
        IdleQueue,
        () => Effect.sync(() => void handled++),
        { concurrency: 0 }
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(PersistedQueueLayer))

    return Effect.gen(function*() {
      const executionId = yield* IdleFlow.execute({ id: "idle" }, { discard: true })
      const result = yield* pollUntilComplete(IdleFlow.poll(executionId))
      expect(handled).toBe(0)
      expect(Option.isSome(result) && result.value._tag === "Complete").toBe(false)
    }).pipe(Effect.provide(layer))
  })
})
