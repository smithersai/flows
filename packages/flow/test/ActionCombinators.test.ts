// Deep reviewed and polished by a human on 2026-08-10.

import { Action, Flow, Interpreter } from "@smthrs/flow-next"
import { Context, Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const Label = Context.Reference<string>("test/Label", { defaultValue: () => "none" })
const Owner = Context.Reference<string>("test/Owner", { defaultValue: () => "none" })

describe("Action combinators", () => {
  effect("annotate returns a new action carrying the annotation", () =>
    Effect.sync(() => {
      const base = Action.make({
        name: "Annotate/base",
        success: Schema.Number,
        execute: Effect.succeed(1)
      })
      const annotated = base.annotate(Label, "audited")

      expect(Context.get(annotated.annotations, Label)).toBe("audited")
      // the original action is untouched
      expect(Context.get(base.annotations, Label)).toBe("none")
      expect(annotated.name).toBe(base.name)
    }))

  effect("annotateMerge merges an annotation context into the action", () =>
    Effect.sync(() => {
      const base = Action.make({
        name: "Annotate/merge",
        success: Schema.Number,
        execute: Effect.succeed(1)
      }).annotate(Label, "first")
      const merged = base.annotateMerge(Context.make(Owner, "will"))

      expect(Context.get(merged.annotations, Owner)).toBe("will")
      // pre-existing annotations survive the merge
      expect(Context.get(merged.annotations, Label)).toBe("first")
    }))

  effect("annotated actions still execute normally", () => {
    const step = Action.make({
      name: "Annotate/execute",
      success: Schema.Number,
      idempotencyKey: "annotate/execute",
      execute: Effect.succeed(7)
    }).annotate(Label, "audited")
    const Run = Action.make("Annotate/execute/run", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Annotate/execute", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Run.call(payload)
    })
    const layer = layerWired(
      Layer.mergeAll(Run.toLayer(() => step), Interpreter.layer(flow))
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "a" })).toBe(7)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll returns the first action result and persists it for replay", () => {
    let fastRuns = 0
    const fast = Action.make({
      name: "Race/fast",
      success: Schema.Number,
      idempotencyKey: "race/fast",
      execute: Effect.sync(() => {
        fastRuns++
        return 1
      })
    })
    const slow = Action.make({
      name: "Race/slow",
      success: Schema.Number,
      idempotencyKey: "race/slow",
      execute: Effect.never as Effect.Effect<number>
    })
    const Race = Action.make("Race/all/run", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Race/all", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Race.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Race.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* Action.raceAll("winner", [fast, slow])
          const second = yield* Action.raceAll("winner", [fast, slow])
          return first + second
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "r" })).toBe(2)
      // the second race reads the persisted deferred instead of racing again
      expect(fastRuns).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll ignores a losing failure and returns the surviving success", () => {
    const failing = Action.make({
      name: "Race/failing",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "race/failing",
      execute: Effect.fail("nope")
    })
    const pending = Action.make({
      name: "Race/pending",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "race/pending",
      execute: Effect.succeed(5)
    })
    const Race = Action.make("Race/failure/run", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Race/failure", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Race.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Race.toLayer(() => Action.raceAll("loser", [failing, pending])),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      // Effect.raceAll only fails when every effect fails
      expect(yield* flow.execute({ id: "f" })).toBe(5)
    }).pipe(Effect.provide(layer))
  })
})
