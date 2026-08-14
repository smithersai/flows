/**
 * A bodied flow driven end to end by the real in-memory engine: the action
 * path a call node takes, the tier it takes it at, the branch decided on a real
 * value, what a duplicate execute of an in-flight execution id does, and what a
 * body re-driven after a park does with the effects it already ran.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow-next"
import { Node } from "@smthrs/plan-next"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const Read = Action.make("body/read", {
  payload: { path: Schema.String },
  success: Schema.Struct({ value: Schema.Number, files: Schema.Array(Schema.String) })
})

const Double = Action.make("body/double", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Pipeline = Flow.make("body/pipeline", {
  payload: { path: Schema.String },
  success: Schema.Number,
  body: ({ path }) =>
    Read.call({ path }).pipe(
      Node.andThen((result) => Double.call({ value: result.value })),
      Node.map((doubled) => doubled + 1)
    )
})

const Decide = Flow.make("body/decide", {
  payload: { path: Schema.String, target: Schema.Number },
  success: Schema.String,
  body: ({ path, target }) =>
    Read.call({ path }).pipe(
      Node.branch({
        if: (result) => result.value >= target,
        then: (result) => Double.call({ value: result.value }).pipe(Node.map((doubled) => `over:${doubled}`)),
        // A planned value is passed on, never computed on: the arm settles
        // with the reference itself, resolved against the real read.
        else: (result) => Node.succeed(result.files[0]!)
      })
    )
})

/** The action invocations one case saw, in dispatch order. */
const wire = (value: number) => {
  const calls: Array<string> = []
  const layer = Layer.mergeAll(
    Read.toLayer(({ path }) =>
      Effect.sync(() => {
        calls.push(`read:${path}`)
        return { value, files: [`${path}.a`] }
      })
    ),
    Double.toLayer((payload) =>
      Effect.sync(() => {
        calls.push(`double:${payload.value}`)
        return payload.value * 2
      })
    ),
    Interpreter.layer(Pipeline),
    Interpreter.layer(Decide)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

/** Polls a result until the predicate holds, so a suspension is observed rather than timed. */
const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>,
  predicate: (result: Flow.Result<A, E>) => boolean
): Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R> =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let index = 0; index < 50 && (Option.isNone(result) || !predicate(result.value)); index++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

describe("bodied flow on the memory engine", () => {
  it("runs each action call through the engine's action path and settles the root", async () => {
    const { calls, layer } = wire(21)

    const value = await runPromise(
      Pipeline.execute({ path: "counter.txt" }, { executionId: "body-pipeline" }).pipe(Effect.provide(layer))
    )

    expect(value).toBe(43)
    expect(calls).toEqual(["read:counter.txt", "double:21"])
  })

  it("takes the arm the predicate chose on the real value, and runs only that arm", async () => {
    const over = wire(100)
    const under = wire(3)

    expect(
      await runPromise(
        Decide.execute({ path: "counter.txt", target: 50 }, { executionId: "body-over" }).pipe(
          Effect.provide(over.layer)
        )
      )
    ).toBe("over:200")
    expect(over.calls).toEqual(["read:counter.txt", "double:100"])

    expect(
      await runPromise(
        Decide.execute({ path: "counter.txt", target: 50 }, { executionId: "body-under" }).pipe(
          Effect.provide(under.layer)
        )
      )
    ).toBe("counter.txt.a")
    expect(under.calls).toEqual(["read:counter.txt"])
  })

  it("dedupes a duplicate execute of an in-flight execution id onto the one running body", async () => {
    // Both calls name one execution id while the body is parked inside its
    // second action, so the engine joins the second onto the fiber already
    // running rather than driving the body twice. Nothing is replayed here:
    // there is one drive, and both callers read its answer.
    const calls: Array<string> = []
    const results = await runPromise(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = Layer.mergeAll(
        Read.toLayer(({ path }) =>
          Effect.sync(() => {
            calls.push(`read:${path}`)
            return { value: 21, files: [`${path}.a`] }
          })
        ),
        Double.toLayer(({ value }) =>
          Effect.gen(function*() {
            calls.push(`double:${value}`)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return value * 2
          })
        ),
        Interpreter.layer(Pipeline)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory)
      )
      const program = Pipeline.execute({ path: "counter.txt" }, { executionId: "body-duplicate" })
      return yield* (Effect.gen(function*() {
        const first = yield* program.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const duplicate = yield* program.pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        return [yield* Fiber.join(first), yield* Fiber.join(duplicate)]
      }).pipe(Effect.provide(layer)) as Effect.Effect<ReadonlyArray<unknown>, unknown>)
    }))

    expect(results).toEqual([43, 43])
    expect(calls).toEqual(["read:counter.txt", "double:21"])
  })

  it("re-drives a body after a park without rerunning the action that already settled", async () => {
    // The genuine re-drive the case above does NOT cover: the first drive
    // settles `Read`, parks, and ends; `resume` builds and walks the body a
    // second time. The settled action replays from its recorded outcome
    // because a re-driven instance re-derives the same invocation key, so the
    // round finishes on the second pass having read once.
    const calls: Array<string> = []
    let approved = false
    const Gated = Flow.make("body/gated", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }): Node.Node<unknown, never, Action.Requirement<"body/read">> =>
        Read.call({ path }).pipe(
          Node.andThen((result): Node.Node<unknown> =>
            approved ? Flow.done(result.value) : Flow.park({ reason: "approval", token: "body-gate" })
          )
        )
    })
    const layer = Layer.mergeAll(
      Read.toLayer(({ path }) =>
        Effect.sync(() => {
          calls.push(`read:${path}`)
          return { value: 21, files: [`${path}.a`] }
        })
      ),
      Interpreter.layer(Gated)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    const observed = await runPromise(
      Effect.gen(function*() {
        yield* Gated.execute({ path: "counter.txt" }, { executionId: "body-park", discard: true })
        const parked = yield* pollUntil(Gated.poll("body-park"), (result) => result._tag === "Suspended")
        approved = true
        yield* Gated.resume("body-park")
        return {
          parked,
          woken: yield* pollUntil(Gated.poll("body-park"), (result) => result._tag === "Complete")
        }
      }).pipe(Effect.provide(layer))
    )

    expect(Option.isSome(observed.parked) && observed.parked.value._tag).toBe("Suspended")
    expect(
      Option.isSome(observed.woken) && observed.woken.value._tag === "Complete" &&
        Exit.isSuccess(observed.woken.value.exit) && observed.woken.value.exit.value
    ).toBe(21)
    // One read across both drives: the re-drive replayed the settled action.
    expect(calls).toEqual(["read:counter.txt"])
  })

  it("dispatches a call node at the tier its declaration carries", async () => {
    // A compensable action is the tier the engine cannot run without a
    // snapshot boundary, so its refusal is proof the node's declared tier
    // reached the engine rather than a default.
    const Compensable = Action.make("body/compensable", {
      payload: { path: Schema.String },
      success: Schema.Void,
      tier: "compensable"
    })
    const Risky = Flow.make("body/risky", {
      payload: { path: Schema.String },
      success: Schema.Void,
      body: ({ path }) => Compensable.call({ path })
    })
    const layer = Layer.mergeAll(
      Compensable.toLayer(() => Effect.void),
      Interpreter.layer(Risky)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    const exit = await runPromise(
      Risky.execute({ path: "counter.txt" }, { executionId: "body-tier" }).pipe(Effect.exit, Effect.provide(layer))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("requires SnapshotBoundary")
  })
})
