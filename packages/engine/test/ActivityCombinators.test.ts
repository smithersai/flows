import { Context, Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const Label = Context.Reference<string>("test/Label", { defaultValue: () => "none" })
const Owner = Context.Reference<string>("test/Owner", { defaultValue: () => "none" })

describe("Activity combinators", () => {
  effect("annotate returns a new activity carrying the annotation", () =>
    Effect.sync(() => {
      const base = Activity.make({
        name: "Annotate/base",
        success: Schema.Number,
        execute: Effect.succeed(1)
      })
      const annotated = base.annotate(Label, "audited")

      expect(Context.get(annotated.annotations, Label)).toBe("audited")
      // the original activity is untouched
      expect(Context.get(base.annotations, Label)).toBe("none")
      expect(annotated.name).toBe(base.name)
    }))

  effect("annotateMerge merges an annotation context into the activity", () =>
    Effect.sync(() => {
      const base = Activity.make({
        name: "Annotate/merge",
        success: Schema.Number,
        execute: Effect.succeed(1)
      }).annotate(Label, "first")
      const merged = base.annotateMerge(Context.make(Owner, "will"))

      expect(Context.get(merged.annotations, Owner)).toBe("will")
      // pre-existing annotations survive the merge
      expect(Context.get(merged.annotations, Label)).toBe("first")
    }))

  effect("annotated activities still execute normally", () => {
    const step = Activity.make({
      name: "Annotate/execute",
      success: Schema.Number,
      idempotencyKey: "annotate/execute",
      execute: Effect.succeed(7)
    }).annotate(Label, "audited")
    const flow = Flow.make("Annotate/execute", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() => step).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "a" })).toBe(7)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll returns the first activity result and persists it for replay", () => {
    let fastRuns = 0
    const fast = Activity.make({
      name: "Race/fast",
      success: Schema.Number,
      idempotencyKey: "race/fast",
      execute: Effect.sync(() => {
        fastRuns++
        return 1
      })
    })
    const slow = Activity.make({
      name: "Race/slow",
      success: Schema.Number,
      idempotencyKey: "race/slow",
      execute: Effect.never as Effect.Effect<number>
    })
    const flow = Flow.make("Race/all", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const first = yield* Activity.raceAll("winner", [fast, slow])
        const second = yield* Activity.raceAll("winner", [fast, slow])
        return first + second
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "r" })).toBe(2)
      // the second race reads the persisted deferred instead of racing again
      expect(fastRuns).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll ignores a losing failure and returns the surviving success", () => {
    const failing = Activity.make({
      name: "Race/failing",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "race/failing",
      execute: Effect.fail("nope")
    })
    const pending = Activity.make({
      name: "Race/pending",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "race/pending",
      execute: Effect.succeed(5)
    })
    const flow = Flow.make("Race/failure", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() => Activity.raceAll("loser", [failing, pending])).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      // Effect.raceAll only fails when every effect fails
      expect(yield* flow.execute({ id: "f" })).toBe(5)
    }).pipe(Effect.provide(layer))
  })
})
