/**
 * The body interpreter, against the authoring package's own runtime fixture:
 * what each node variant does when it is driven with real values, and what the
 * interpreter refuses.
 */
import { Activity, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, expectTypeOf, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const Read = Activity.make("interpreter/read", {
  payload: { path: Schema.String },
  success: Schema.Struct({ value: Schema.Number, files: Schema.Array(Schema.String) })
})

const Write = Activity.make("interpreter/write", {
  payload: { path: Schema.String, value: Schema.Number },
  success: Schema.Number
})

const Sum = Activity.make("interpreter/sum", {
  payload: { values: Schema.Array(Schema.Number), label: Schema.String },
  success: Schema.Number
})

/** The calls each activity received, in the order the walk dispatched them. */
const calls: Array<string> = []

const implementations = Layer.mergeAll(
  Read.toLayer(({ path }) =>
    Effect.sync(() => {
      calls.push(`read:${path}`)
      return { value: 41, files: [`${path}.a`, `${path}.b`] }
    })
  ),
  Write.toLayer(({ path, value }) =>
    Effect.sync(() => {
      calls.push(`write:${path}:${value}`)
      return value + 1
    })
  ),
  Sum.toLayer(({ label, values }) =>
    Effect.sync(() => {
      calls.push(`sum:${label}`)
      return values.reduce((total, value) => total + value, 0)
    })
  )
)

/** What a layer under test may ask for: the table, and a runtime to register with. */
type Wiring = Layer.Layer<never, never, FlowRuntime.FlowRuntime | Activity.Implementations>

/** Everything a driven body needs: the table, the implementations, a runtime. */
const wired = (
  registration: Wiring = Layer.empty
): Layer.Layer<FlowRuntime.FlowRuntime | Activity.Implementations> =>
  Layer.merge(implementations, registration).pipe(
    Layer.provideMerge(Activity.layerImplementations),
    Layer.provideMerge(layerMemory)
  )

/** A bare interpretation, outside any registered flow execution. */
const drive = <A, E>(
  effect: Effect.Effect<A, E, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Activity.Implementations>,
  layer: Layer.Layer<
    FlowRuntime.FlowRuntime | Activity.Implementations,
    never,
    never
  > = wired()
): Promise<A> =>
  runPromise(
    effect.pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        makeInstance(Flow.make("interpreter/host", { payload: {} }), "interpretation")
      ),
      Effect.provide(layer)
    )
  )

/** An AST that crossed a serialization boundary, leaving its side tables behind. */
const detached = <A>(built: Node.Node<A>): Node.Node<A> => ({
  ...built,
  ast: JSON.parse(JSON.stringify(built.ast)) as Node.Ast
})

const refusal = async (
  effect: Effect.Effect<
    unknown,
    unknown,
    FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Activity.Implementations
  >
): Promise<unknown> => {
  const exit = await drive(Effect.exit(effect))
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
}

describe("Interpreter.layer", () => {
  it("drives activities, reference paths, and a deferred map end to end", async () => {
    calls.length = 0
    const Pipeline = Flow.make("interpreter/pipeline", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) =>
        Read.call({ path }).pipe(
          Node.andThen((result) => Write.call({ path: result.files[1]!, value: result.value })),
          Node.map((written) => written * 2)
        )
    })

    const value = await runPromise(
      Pipeline.execute({ path: "counter.txt" }, { executionId: "pipeline-1" }).pipe(
        Effect.provide(wired(Interpreter.layer(Pipeline)))
      )
    )

    expect(value).toBe(84)
    expect(calls).toEqual(["read:counter.txt", "write:counter.txt.b:41"])
  })

  it("returns the recorded result for a replayed execution id without rerunning the effects", async () => {
    calls.length = 0
    const Replayed = Flow.make("interpreter/replayed", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) => Write.call({ path, value: 1 })
    })
    const layer = wired(Interpreter.layer(Replayed))

    const results = await runPromise(
      Effect.gen(function*() {
        const first = yield* Replayed.execute({ path: "replay.txt" }, { executionId: "replay-1" })
        const second = yield* Replayed.execute({ path: "replay.txt" }, { executionId: "replay-1" })
        return [first, second]
      }).pipe(Effect.provide(layer))
    )

    expect(results).toEqual([2, 2])
    expect(calls).toEqual(["write:replay.txt:1"])
  })

  it("dies when the flow it is asked to register has no body", async () => {
    const Bodyless = Flow.make("interpreter/bodyless", {
      payload: { path: Schema.String },
      success: Schema.Number
    })
    const exit = await runPromise(
      Effect.exit(Effect.void.pipe(Effect.provide(wired(Interpreter.layer(Bodyless)))))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
      defect: {
        _tag: "@smthrs/flow/InterpreterError",
        code: "missing_body",
        flow: "interpreter/bodyless",
        node: "root"
      }
    })
  })
})

describe("Interpreter payload resolution", () => {
  it("keeps an own __proto__ field as data in the value a node is driven with", async () => {
    const interpretation = await drive(
      Interpreter.interpret(Node.succeed({ data: { ["__proto__"]: "own" } }))
    )
    const data = (interpretation.value as { readonly data: Record<string, unknown> }).data

    expect(Object.hasOwn(data, "__proto__")).toBe(true)
    expect(data["__proto__"]).toBe("own")
  })

  it("records an object-valued own __proto__ field instead of reparenting the resolved value", async () => {
    const interpretation = await drive(
      Interpreter.interpret(Node.succeed({ data: { ["__proto__"]: { evil: 1 } } }))
    )
    const data = (interpretation.value as { readonly data: Record<string, unknown> }).data

    expect(Object.getPrototypeOf(data)).toBe(null)
    expect(data["__proto__"]).toEqual({ evil: 1 })
    // Reparenting would have served `evil` off the prototype instead.
    expect(data["evil"]).toBeUndefined()
  })
})

describe("Interpreter branches", () => {
  const Increment = Activity.make("interpreter/increment", {
    payload: { path: Schema.String },
    success: Schema.Number
  })

  const CountTo = (settledValue: number) =>
    Layer.mergeAll(Increment.toLayer(() => Effect.succeed(settledValue))).pipe(
      Layer.provideMerge(Activity.layerImplementations),
      Layer.provideMerge(layerMemory)
    )

  const Decide = Flow.make("interpreter/decide", {
    payload: { path: Schema.String, target: Schema.Number },
    success: Schema.Unknown,
    body: ({ path, target }): Node.Node<unknown> =>
      Increment.call({ path }).pipe(
        Node.branch({
          if: (value) => value >= target,
          then: (value) => Flow.done(value),
          else: (): Node.Node<unknown> => Decide.to({ path, target })
        })
      )
  })

  it("takes the then arm on a real value and settles the untaken arm as skipped", async () => {
    const interpretation = await drive(
      Interpreter.interpret(Decide, { path: "counter.txt", target: 100 }),
      CountTo(100)
    )

    expect(interpretation.value).toEqual({ _tag: "Done", value: 100 })
    expect(interpretation.skipped).toEqual(["root.flow.else"])
    expect(interpretation.settled.get("root.flow.branch")).toBe(100)
  })

  it("takes the else arm on a real value, and the taken arm is the one that settles", async () => {
    const interpretation = await drive(
      Interpreter.interpret(Decide, { path: "counter.txt", target: 100 }),
      CountTo(7)
    )

    expect(interpretation.value).toEqual({
      _tag: "To",
      flow: "interpreter/decide",
      payload: { path: "counter.txt", target: 100 }
    })
    expect(interpretation.skipped).toEqual(["root.flow.then"])
  })

  it("refuses a branch whose predicate did not survive serialization", async () => {
    const lost = detached(
      Node.succeed(1).pipe(
        Node.branch({ if: (value) => value > 0, then: () => Node.succeed("yes"), else: () => Node.succeed("no") })
      )
    )

    expect(await refusal(Interpreter.interpret(lost))).toMatchObject({
      error: { _tag: "@smthrs/flow/InterpreterError", code: "missing_operation", node: "root" }
    })
  })
})

describe("Interpreter node variants", () => {
  it("joins a combination by member name and threads planned arrays into a payload", async () => {
    calls.length = 0
    const Joined = Flow.make("interpreter/joined", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) =>
        Node.all({ left: Read.call({ path }), right: Node.succeed(2) }).pipe(
          Node.andThen((both) => Sum.call({ values: [both.left.value, both.right], label: path }))
        )
    })

    const interpretation = await drive(Interpreter.interpret(Joined, { path: "counter.txt" }))

    expect(interpretation.value).toBe(43)
    expect(interpretation.settled.get("root.flow.andThen")).toEqual({
      left: { value: 41, files: ["counter.txt.a", "counter.txt.b"] },
      right: 2
    })
    expect(interpretation.skipped).toEqual([])
    expect(calls).toEqual(["read:counter.txt", "sum:counter.txt"])
  })

  it("settles a bare node graph under a caller-chosen root", async () => {
    const interpretation = await drive(
      Interpreter.interpret(
        Node.succeed({ label: "round", nothing: null, values: [1, 2] }),
        undefined,
        { root: "round-1" }
      )
    )

    expect(interpretation.value).toEqual({ label: "round", nothing: null, values: [1, 2] })
    expect([...interpretation.settled.keys()]).toEqual(["round-1"])
  })

  it("refuses a payload reference to a node this graph does not hold", async () => {
    calls.length = 0
    const Follow = Flow.make("interpreter/follow", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) => Write.call({ path: "next.txt", value })
    })

    // The shape `Plan.append` plans a later round in: a payload naming a node
    // an earlier generation settled. One interpretation settles one graph.
    expect(
      await refusal(
        Interpreter.interpret(
          Follow,
          { value: Planned.make<number>("round-0") },
          { root: "round-1" }
        )
      )
    ).toMatchObject({
      error: {
        _tag: "@smthrs/flow/InterpreterError",
        code: "unresolved_reference",
        node: "round-1.flow",
        message: expect.stringContaining("round-0")
      }
    })
    expect(calls).toEqual([])
  })
})

describe("Interpreter refusals", () => {
  const Missing = Activity.make("interpreter/missing", {
    payload: { path: Schema.String },
    success: Schema.Number
  })

  it("names the activity that has no implementation", async () => {
    const Orphan = Flow.make("interpreter/orphan", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) => Missing.call({ path })
    })

    expect(await refusal(Interpreter.interpret(Orphan, { path: "counter.txt" }))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/InterpreterError",
        code: "unresolved_activity",
        flow: "interpreter/orphan",
        node: "root.flow",
        message: expect.stringContaining("interpreter/missing.toLayer(execute)")
      }
    })
  })

  it("refuses an unimplemented activity before the implemented ones ahead of it run", async () => {
    calls.length = 0
    // Wiring is knowable from the graph, so it is refused from the graph. The
    // alternative surfaces the same error after `Read` has already committed
    // whatever its implementation does.
    const Half = Flow.make("interpreter/half-wired", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) => Read.call({ path }).pipe(Node.andThen((result) => Missing.call({ path: result.files[0]! })))
    })

    expect(await refusal(Interpreter.interpret(Half, { path: "counter.txt" }))).toMatchObject({
      error: { code: "unresolved_activity", node: "root.flow.then" }
    })
    expect(calls).toEqual([])
  })

  it("refuses a graph whose topology is incomplete", async () => {
    const lost = detached(Node.succeed(1).pipe(Node.andThen(() => Node.succeed(2))))

    expect(await refusal(Interpreter.interpret(lost))).toMatchObject({
      error: { _tag: "@smthrs/flow/InterpreterError", code: "incomplete_graph", flow: "node", node: "root" }
    })
  })

  it("refuses a map whose deferred function did not survive serialization", async () => {
    const lost = detached(Node.succeed(1).pipe(Node.map((value) => value + 1)))

    expect(await refusal(Interpreter.interpret(lost))).toMatchObject({
      error: { _tag: "@smthrs/flow/InterpreterError", code: "missing_operation", node: "root" }
    })
  })

  it("refuses an inline call it keeps as a leaf, naming the body and the boundary as the fixes", async () => {
    // A body-less callee has nothing to splice, so an inline call to it stays a
    // leaf — and a leaf inline call is the one flow node with no behavior at
    // all. `.child()` is a leaf too, but it has an execution underneath it.
    const Bodyless = Flow.make("interpreter/leaf-callee", {
      payload: { path: Schema.String },
      success: Schema.Number
    })
    const inline: Node.Node<number> = Node.flowCall(Bodyless, "interpreter/leaf-callee", "inline", { path: "p" })

    expect(await refusal(Interpreter.interpret(inline))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/InterpreterError",
        code: "unsupported_call",
        node: "root",
        message: expect.stringContaining("interpreter/leaf-callee.child(payload)")
      }
    })
  })

  it("refuses a detached handoff whose declaration cannot encode its payload", async () => {
    const Target = Flow.make("interpreter/handoff-target", {
      payload: { path: Schema.String },
      success: Schema.Number
    })
    const lost = detached(
      Node.flowCall<number>(Target, Target._tag, "handoff", { path: "p" })
    )

    expect(await refusal(Interpreter.interpret(lost))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/InterpreterError",
        code: "unsupported_call",
        node: "root",
        message: expect.stringContaining("lost its declaration")
      }
    })
  })
})

describe("Flow.toLayer on a bodied flow", () => {
  const Bodied = Flow.make("interpreter/bodied", {
    payload: { path: Schema.String },
    success: Schema.Number,
    body: ({ path }) => Write.call({ path, value: 1 })
  })

  it("is not callable", () => {
    expectTypeOf(Bodied.toLayer).toEqualTypeOf<never>()
  })

  it("is still not callable after the flow is annotated", () => {
    // `annotate` carries the body across, so the declaration it answers with is
    // still bodied — and must still refuse a second behavior.
    expectTypeOf(Bodied.annotate(Flow.Capabilities, ["fs"]).toLayer).toEqualTypeOf<never>()
    expectTypeOf(Bodied.annotateMerge(Context.empty()).toLayer).toEqualTypeOf<never>()
  })

  it("dies naming the body as the behavior a bodied flow already has", async () => {
    const erased = Bodied as unknown as {
      readonly toLayer: (
        execute: () => Effect.Effect<number>
      ) => Layer.Layer<never, never, FlowRuntime.FlowRuntime>
    }
    const exit = await runPromise(
      Effect.exit(
        Effect.void.pipe(
          Effect.provide(erased.toLayer(() => Effect.succeed(1)).pipe(Layer.provideMerge(layerMemory)))
        )
      ) as Effect.Effect<Exit.Exit<void, never>, never, Crypto.Crypto>
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
      defect: {
        _tag: "@smthrs/flow/BodyDefinesBehavior",
        code: "body_defines_behavior",
        flowName: "interpreter/bodied",
        message: expect.stringContaining("Interpreter.layer(interpreter/bodied)")
      }
    })
  })
})
