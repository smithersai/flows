import { Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { Activity, Flow, FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>,
  predicate: (result: Flow.Result<A, E>) => boolean
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 200 && (Option.isNone(result) || !predicate(result.value)); i++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

describe("Flow.make payload and schema defaults", () => {
  effect("accepts an already-built payload schema as well as a field record", () => {
    const fields = Flow.make("Definition/fields", {
      payload: { id: Schema.String }
    })
    const struct = Schema.Struct({ id: Schema.String })
    const built = Flow.make("Definition/built", { payload: struct })
    return Effect.sync(() => {
      // a field record is wrapped; a schema is adopted as-is
      expect(built.payloadSchema).toBe(struct)
      expect(fields.payloadSchema).not.toBe(struct)
      expect(fields.payloadSchema.make({ id: "a" })).toEqual({ id: "a" })
      expect(built.payloadSchema.make({ id: "a" })).toEqual({ id: "a" })
    })
  })

  effect("defaults success to Void and error to Never when neither is declared", () => {
    const flow = Flow.make("Definition/defaults", {
      payload: { id: Schema.String }
    })
    const layer = flow.toLayer(() => Effect.void).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(flow.successSchema.ast).toBe(Schema.Void.ast)
      expect(flow.errorSchema.ast).toBe(Schema.Never.ast)
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  effect("keeps declared success and error schemas instead of the defaults", () => {
    const flow = Flow.make("Definition/declared", {
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      error: Schema.String
    })
    const layer = flow.toLayer(() => Effect.succeed(1)).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(flow.successSchema.ast).toBe(Schema.Number.ast)
      expect(flow.errorSchema.ast).toBe(Schema.String.ast)
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("a flow definition is an inert callable proto object, per effect's Workflow shape", () => {
    // `makeProto` builds the definition on a function object so it mirrors
    // effect's `Workflow`. Invoking it is not part of the API: it must be a
    // no-op that neither throws nor mutates the definition.
    const flow = Flow.make("Definition/proto", { payload: { id: Schema.String } })
    return Effect.sync(() => {
      expect(typeof flow).toBe("function")
      expect((flow as unknown as () => unknown)()).toBeUndefined()
      expect(flow._tag).toBe("Definition/proto")
    })
  })
})

describe("Flow definition combinators", () => {
  effect("withCompensation is reachable from the definition as well as the module", () => {
    const compensated: Array<string> = []
    const flow = Flow.make("Definition/compensation", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        yield* flow.withCompensation(
          Effect.succeed("resource"),
          (value: string) => Effect.sync(() => void compensated.push(`undo:${value}`))
        )
        return yield* Effect.fail("boom")
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(compensated).toEqual(["undo:resource"])
    }).pipe(Effect.provide(layer))
  })

  effect("the definition-level combinator leaves a successful flow uncompensated", () => {
    const compensated: Array<string> = []
    const flow = Flow.make("Definition/compensation-ok", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const layer = flow.toLayer(() =>
      flow.withCompensation(
        Effect.succeed("kept"),
        (value: string) => Effect.sync(() => void compensated.push(`undo:${value}`))
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe("kept")
      expect(compensated).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("concurrent activity bookkeeping", () => {
  effect("an activity finishing while a sibling still runs does not release the suspension latch", () => {
    const events: Array<string> = []
    const quick = Activity.make({
      name: "Definition/quick",
      success: Schema.String,
      execute: Effect.sync(() => {
        events.push("quick")
        return "quick"
      })
    })
    const slow = Activity.make({
      name: "Definition/slow-sibling",
      success: Schema.String,
      execute: Effect.gen(function*() {
        for (let i = 0; i < 8; i++) yield* Effect.yieldNow
        events.push("slow")
        return "slow"
      })
    })
    const flow = Flow.make("Definition/concurrent-pair", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const layer = flow.toLayer(() =>
      Effect.map(
        Effect.all([slow, quick], { concurrency: "unbounded" }),
        ([a, b]) => `${a}+${b}`
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-pair" })).toBe("slow+quick")
      // the quick activity settled first, while the slow one was still in flight
      expect(events).toEqual(["quick", "slow"])
    }).pipe(Effect.provide(layer))
  })

  effect("combines the causes of several activities that suspend together", () => {
    // Two activities suspend with a cause each: the instance must accumulate
    // both, not drop the first.
    const failing = (name: string, reason: string, delay: number) =>
      Activity.make({
        name,
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function*() {
          for (let i = 0; i < delay; i++) yield* Effect.yieldNow
          return yield* Effect.fail(reason)
        })
      })
    const flow = Flow.make("Definition/two-suspensions", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = flow.toLayer(() =>
      Effect.map(
        Effect.all([failing("Definition/f1", "first-boom", 1), failing("Definition/f2", "second-boom", 2)], {
          concurrency: "unbounded",
          mode: "result"
        }),
        () => "unreachable"
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-two-suspend", discard: true })
      const suspended = yield* pollUntil(
        flow.poll("run-two-suspend"),
        (result) => result._tag === "Suspended"
      )
      expect(Option.isSome(suspended)).toBe(true)
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        const cause = String(suspended.value.cause)
        expect(cause).toContain("first-boom")
        expect(cause).toContain("second-boom")
      }
    }).pipe(Effect.provide(layer))
  })
})

describe("suspension while siblings are still running", () => {
  effect("carries the suspending activity's cause and waits for the running sibling", () => {
    // `wrapActivityResult` must (1) merge the cause reported by a suspended
    // activity onto the instance and (2) hold suspension open until every
    // concurrently running activity has settled — otherwise a sibling is
    // abandoned mid-flight and re-runs on resume.
    const events: Array<string> = []
    const failing = Activity.make({
      name: "Definition/failing",
      success: Schema.String,
      error: Schema.String,
      execute: Effect.gen(function*() {
        events.push("failing:start")
        // let the sibling start before this one suspends the flow
        for (let i = 0; i < 3; i++) yield* Effect.yieldNow
        return yield* Effect.fail("gate-closed")
      })
    })
    const slow = Activity.make({
      name: "Definition/slow",
      success: Schema.String,
      execute: Effect.gen(function*() {
        events.push("slow:start")
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow
        events.push("slow:end")
        return "slow"
      })
    })
    const flow = Flow.make("Definition/suspend-with-sibling", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    }).annotate(Flow.SuspendOnFailure, true)

    let attempts = 0
    const layer = flow.toLayer(() =>
      Effect.suspend(() => {
        attempts++
        return attempts === 1
          ? Effect.map(
            Effect.all([failing, slow], { concurrency: "unbounded" }),
            ([a, b]) => `${a}+${b}`
          )
          : Effect.succeed("recovered")
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-sibling", discard: true })
      const suspended = yield* pollUntil(
        flow.poll("run-sibling"),
        (result) => result._tag === "Suspended"
      )
      expect(Option.isSome(suspended)).toBe(true)
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        expect(String(suspended.value.cause)).toContain("gate-closed")
      }
      // the sibling that had already started was allowed to finish
      expect(events).toContain("slow:start")
      expect(events).toContain("slow:end")

      yield* flow.resume("run-sibling")
      const done = yield* pollUntil(
        flow.poll("run-sibling"),
        (result) => result._tag === "Complete"
      )
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("recovered")
    }).pipe(Effect.provide(layer))
  })
})
