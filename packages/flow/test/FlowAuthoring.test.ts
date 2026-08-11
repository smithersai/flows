import { Flow } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Context, Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"

describe("Flow body and calls", () => {
  it("stores a plan-time body typed with the decoded payload", () => {
    const body = (payload: { readonly count: number }) => {
      expectTypeOf(payload.count).toEqualTypeOf<number>()
      return Node.succeed(payload.count + 1)
    }
    const flow = Flow.make("Authoring/body", {
      payload: { count: Schema.NumberFromString },
      success: Schema.Number,
      body
    })

    expect(flow.body).toBe(body)
    expect(flow.body?.({ count: 2 }).ast).toEqual({ _tag: "Succeed", value: 3 })
  })

  it("builds an inline flow-call node with planned payload references", () => {
    const flow = Flow.make("Authoring/call", {
      payload: { count: Schema.Number },
      success: Schema.String,
      error: Schema.Number
    })
    const count = Planned.make<number>("upstream")

    expect(flow.call({ count }).ast).toEqual({
      _tag: "FlowCall",
      flow: "Authoring/call",
      mode: "inline",
      payload: {
        count: { _tag: "PlannedReference", node: "upstream", path: [] }
      }
    })
  })

  it("preserves the body when annotations are added or merged", () => {
    const body = ({ count }: { readonly count: number }) => Node.succeed(count)
    const flow = Flow.make("Authoring/body-annotations", {
      payload: { count: Schema.Number },
      body
    })

    expect(flow.annotate(Flow.Capabilities, ["fs:read"]).body).toBe(body)
    expect(flow.annotateMerge(Context.make(Flow.Capabilities, ["fs:write"])).body).toBe(body)
  })
})

describe("Flow trampoline outcomes", () => {
  const roundTrip = <A extends Flow.Outcome>(value: A) =>
    Effect.runPromise(
      Effect.flatMap(
        Schema.encodeEffect(Schema.toCodecJson(Flow.Outcome))(value),
        Schema.decodeEffect(Schema.toCodecJson(Flow.Outcome))
      )
    )

  it("constructs and round trips done", async () => {
    const node = Flow.done({ answer: 42 })
    expect(node.ast).toEqual({ _tag: "Succeed", value: { _tag: "Done", value: { answer: 42 } } })
    const value = (node.ast as { readonly value: Flow.Outcome }).value
    expect(value).toEqual({ _tag: "Done", value: { answer: 42 } })
    expect(await roundTrip(value)).toEqual(value)
  })

  it("constructs and round trips a typed next-flow invocation", async () => {
    const flow = Flow.make("Authoring/next", {
      payload: { count: Schema.NumberFromString }
    })
    const node = flow.to({ count: 2 })
    const value = (node.ast as { readonly value: Flow.To<{ readonly count: number }> }).value

    expectTypeOf(value.payload.count).toEqualTypeOf<number>()
    expect(value).toEqual({
      _tag: "To",
      flow: "Authoring/next",
      payload: { count: 2 }
    })
    expect(await roundTrip(value)).toEqual(value)
  })

  it("constructs and round trips park with the waiting reason vocabulary", async () => {
    const node = Flow.park({ reason: "approval", wakeAt: 100, token: "request-1" })
    const value = (node.ast as { readonly value: Flow.Park }).value
    expect(value).toEqual({
      _tag: "Park",
      reason: { reason: "approval", wakeAt: 100, token: "request-1" }
    })
    expect(await roundTrip(value)).toEqual(value)
  })
})

describe("Flow authoring annotations", () => {
  it("defaults capabilities and attaches all authoring annotations", () => {
    const effects: Flow.Effects = {
      reads: ["src/**"],
      writes: ["dist/**"],
      boundaryMode: "hard"
    }
    const placement: Flow.PlacementDirective = { host: "sandbox" }
    const original = Flow.make("Authoring/annotations", { payload: {} })
    const annotated = original
      .annotate(Flow.Capabilities, ["fs:read"])
      .annotate(Flow.EffectsDeclaration, effects)
      .annotate(Flow.Placement, placement)

    expect(Context.get(original.annotations, Flow.Capabilities)).toEqual([])
    expect(Context.get(annotated.annotations, Flow.Capabilities)).toEqual(["fs:read"])
    expect(Context.getUnsafe(annotated.annotations, Flow.EffectsDeclaration)).toEqual(effects)
    expect(Context.getUnsafe(annotated.annotations, Flow.Placement)).toEqual(placement)
  })
})
