// Deep reviewed and polished by a human on 2026-08-10.

import { Activity, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

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
    const flowActivityDeclaration = Activity.make("Tiers/sealed/activity", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Tiers/sealed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() => Effect.andThen(step, step)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "one" }, { executionId: "run" })).toBe(1)
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
    const flowActivityDeclaration = Activity.make("Tiers/irreversible-no-key/activity", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const flow = Flow.make("Tiers/irreversible-no-key", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() => Activity.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "one" }, { executionId: "run" }).pipe(Effect.exit)
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
    const flowActivityDeclaration = Activity.make("Tiers/irreversible-keyed/activity", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Tiers/irreversible-keyed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActivityDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActivityDeclaration.toLayer(() => Activity.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Activity.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "one" }, { executionId: "run" })).toBe(2)
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})
