/**
 * The three settlements a bodied round can produce, at the authoring package's
 * own boundary: the `Handoff` result beside `Complete` and `Suspended`, the
 * guard that recognizes an outcome value, and what the interpreter does with
 * each of `done` / `to` / `park`.
 *
 * Following a handoff to the next round is the ENGINE's job, so the port
 * fixture here settles a handed-off round as itself; `@smthrs/engine-next` and
 * `@smthrs/engine-store-next` own the lineage tests.
 */
import { Activity, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow-next"
import { Node } from "@smthrs/plan-next"
import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const Increment = Activity.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const increments = Increment.toLayer(({ value }) => Effect.succeed(value + 1))

/** The declaration shape the recursive body names itself under. */
type CounterFlow = Flow.Flow<
  "trampoline/counter",
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never
>

const Counter: CounterFlow = Flow.make("trampoline/counter", {
  payload: { value: Schema.Number, target: Schema.Number },
  success: Schema.Number,
  body: ({ target, value }: { readonly value: number; readonly target: number }) =>
    Increment.call({ value }).pipe(
      Node.branch({
        if: (next) => next >= target,
        then: (next) => Flow.done(next),
        else: (next) => Counter.to({ value: next, target })
      })
    )
})

const Parking = Flow.make("trampoline/parking", {
  payload: { token: Schema.String },
  success: Schema.Number,
  body: ({ token }) => Flow.park({ reason: "approval", token })
})

const EncodedTarget = Flow.make("trampoline/encoded-target", {
  payload: { count: Schema.NumberFromString },
  success: Schema.Number,
  body: () => Node.succeed(undefined)
})

const EncodedSource = Flow.make("trampoline/encoded-source", {
  payload: {},
  success: Schema.Number,
  body: () => EncodedTarget.to({ count: 2 })
})

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Activity.Implementations>
): Layer.Layer<FlowRuntime.FlowRuntime | Activity.Implementations> =>
  Layer.merge(increments, registration).pipe(
    Layer.provideMerge(Activity.layerImplementations),
    Layer.provideMerge(layerMemory)
  )

describe("Flow.Handoff", () => {
  it("is a Result beside Complete and Suspended, and survives the result codec", async () => {
    const handoff = new Flow.Handoff({ flow: "trampoline/counter", payload: { value: 1 } })

    expect(Flow.isResult(handoff)).toBe(true)
    expect(handoff._tag).toBe("Handoff")

    const codec = Schema.toCodecJson(
      Flow.Result({ success: Schema.Number, error: Schema.Never })
    )
    const encoded = await runPromise(Schema.encodeEffect(codec)(handoff))
    expect(encoded).toEqual({
      _tag: "Handoff",
      flow: "trampoline/counter",
      payload: { value: 1 }
    })
    const decoded = await runPromise(Schema.decodeUnknownEffect(codec)(encoded))
    expect(decoded._tag).toBe("Handoff")
    expect(decoded._tag === "Handoff" && decoded.flow).toBe("trampoline/counter")
  })

  it("records itself on the instance, so intoResult answers with it", async () => {
    const instance = makeInstance(Parking, "handoff-instance")

    const result = await runPromise(
      Effect.succeed("ignored").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            instance.handoff = new Flow.Handoff({ flow: "next", payload: { n: 2 } })
          })
        ),
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
    )

    // The value the handler returned is discarded: a round that handed off
    // produced no answer of its own.
    expect(result._tag).toBe("Handoff")
    expect(result._tag === "Handoff" && result.payload).toEqual({ n: 2 })
  })
})

describe("Flow.Outcome.isOutcome", () => {
  it("recognizes the three settlements and nothing else", () => {
    expect(Flow.isOutcome({ _tag: "Done", value: 1 })).toBe(true)
    expect(Flow.isOutcome({ _tag: "To", flow: "f", payload: {} })).toBe(true)
    expect(Flow.isOutcome({ _tag: "Park", reason: { reason: "quota" } })).toBe(true)
    // A tagged value that is not an outcome, and a value with no tag at all:
    // both arms of the guard.
    expect(Flow.isOutcome({ _tag: "Complete" })).toBe(false)
    expect(Flow.isOutcome({ _tag: "To" })).toBe(false)
    expect(Flow.isOutcome({ _tag: "Park", reason: {} })).toBe(false)
    expect(Flow.isOutcome({ value: 1 })).toBe(false)
    expect(Flow.isOutcome(undefined)).toBe(false)
  })
})

describe("the interpreter settles a body's root outcome", () => {
  it("records a to invocation as a handoff site in the static graph", () => {
    const graph = Graph.build(Counter, { value: 0, target: 10 })
    const handoff = Graph.nodes(graph).find(
      (node) => node.ast._tag === "FlowCall" && node.ast.mode === "handoff"
    )

    expect(handoff?.ast).toMatchObject({
      _tag: "FlowCall",
      flow: "trampoline/counter",
      mode: "handoff"
    })
  })

  it("answers with the value a done arm carried", async () => {
    const value = await runPromise(
      Counter.execute({ value: 9, target: 10 }, { executionId: "settle-done" }).pipe(
        Effect.provide(wired(Interpreter.layer(Counter)))
      )
    )

    expect(value).toBe(10)
  })

  it("hands off when the arm taken is a to invocation", async () => {
    const settled = await runPromise(
      (Counter.execute({ value: 0, target: 10 }, { executionId: "settle-to" }) as Effect.Effect<
        unknown,
        never,
        FlowRuntime.FlowRuntime
      >).pipe(Effect.provide(wired(Interpreter.layer(Counter))))
    )

    expect(Flow.isResult(settled) && settled._tag).toBe("Handoff")
    expect(
      Flow.isResult(settled) && settled._tag === "Handoff" ? settled.payload : undefined
    ).toEqual({ value: 1, target: 10 })
  })

  it("encodes the target payload before settling Handoff", async () => {
    const settled = await runPromise(
      (EncodedSource.execute({}, { executionId: "settle-encoded-to" }) as Effect.Effect<
        unknown,
        never,
        FlowRuntime.FlowRuntime
      >).pipe(Effect.provide(wired(Interpreter.layer(EncodedSource))))
    )

    expect(
      Flow.isResult(settled) && settled._tag === "Handoff" ? settled.payload : undefined
    ).toEqual({ count: "2" })
  })

  it("parks under the reason the body declared", async () => {
    const result = await runPromise(
      Effect.gen(function*() {
        const executionId = yield* Parking.execute({ token: "req-7" }, {
          executionId: "settle-park",
          discard: true
        })
        let polled = yield* Parking.poll(executionId)
        for (let index = 0; index < 300 && Option.isNone(polled); index++) {
          yield* Effect.sleep(1)
          polled = yield* Parking.poll(executionId)
        }
        return polled
      }).pipe(Effect.provide(wired(Interpreter.layer(Parking))))
    )

    expect(Option.isSome(result) && result.value._tag).toBe("Suspended")
  })

  it("leaves a body that settles with an ordinary value alone", async () => {
    const Plain = Flow.make("trampoline/plain", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) => Increment.call({ value })
    })

    const settled = await runPromise(
      Plain.execute({ value: 4 }, { executionId: "settle-plain" }).pipe(
        Effect.provide(wired(Interpreter.layer(Plain)))
      )
    )

    expect(settled).toBe(5)
  })
})

describe("Flow.MaxRoundsExceeded", () => {
  it("carries the lineage, the budget, and the round that was refused", () => {
    const error = new Flow.MaxRoundsExceeded({
      flowName: "trampoline/counter",
      lineageId: "lineage-1",
      maxRounds: 3,
      roundOrdinal: 3,
      message: "past the budget"
    })

    expect(error._tag).toBe("@smthrs/flow-next/MaxRoundsExceeded")
    expect(error.code).toBe("max_rounds_exceeded")
    expect(error.roundOrdinal).toBe(3)
  })

  it("rejects a non-positive or non-integral round budget at declaration time", () => {
    const declare = (maxRounds: number) =>
      Flow.make("trampoline/invalid-budget", {
        payload: {},
        maxRounds,
        body: () => Node.succeed(undefined)
      })

    expect(() => declare(0)).toThrow(RangeError)
    expect(() => declare(1.5)).toThrow(RangeError)
  })
})
