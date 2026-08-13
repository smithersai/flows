/**
 * The requirement channel: what a plan demands, what an execution demands, and
 * the gap between them.
 *
 * The rule this suite buys is one sentence: PLANNING is requirement-free and
 * EXECUTING is not. A body that names an activity records a node and nothing
 * else, so building, keying, and diffing a plan never ask for an
 * implementation; asking to RUN that plan is what makes a forgotten
 * `toLayer` a compile error instead of a run that dies partway through.
 *
 * Most of it is therefore a TYPE test. The repo's convention for those is
 * vitest's `expectTypeOf` beside `@ts-expect-error`, checked by
 * `tsc -p tsconfig.test.json` in `npm run check`, so a red type assertion
 * fails the gate whether or not the suite is run.
 */
import { Activity, Flow, FlowRuntime, Graph, Interpreter, Sleep, WaitFor } from "@smthrs/flow-next"
import { Node } from "@smthrs/plan-next"
import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const Charge = Activity.make("requirement/charge", {
  payload: { cents: Schema.Number },
  success: Schema.Number,
  error: Schema.String
})

const Refund = Activity.make("requirement/refund", {
  payload: { cents: Schema.Number },
  success: Schema.Number
})

const Audit = Activity.make("requirement/audit", {
  payload: { note: Schema.String },
  success: Schema.String
})

type ChargeNeeded = Activity.Requirement<"requirement/charge">
type RefundNeeded = Activity.Requirement<"requirement/refund">
type AuditNeeded = Activity.Requirement<"requirement/audit">

const charges = Charge.toLayer(({ cents }) => Effect.succeed(cents))
const refunds = Refund.toLayer(({ cents }) => Effect.succeed(-cents))
const audits = Audit.toLayer(({ note }) => Effect.succeed(note))

describe("planning is requirement-free", () => {
  it("builds and keys a graph with nothing provided", () => {
    const Paying = Flow.make("requirement/paying", {
      payload: { cents: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      body: ({ cents }) => Charge.call({ cents })
    })

    // `Graph.build` takes the flow and the payload and answers with a plan. It
    // is a pure function: no Effect, so no channel to demand anything through.
    const graph = Graph.build(Paying, { cents: 100 })

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.nodes(graph).map((observed) => observed.kind)).toEqual(["ActivityCall", "FlowCall"])
    expectTypeOf(graph).not.toBeNever()
  })

  it("keeps the channel off the node's data, so the AST is unchanged by it", () => {
    const node = Charge.call({ cents: 100 })

    expectTypeOf(node).toEqualTypeOf<Node.Node<number, string, ChargeNeeded>>()
    expect(node.ast).toEqual({
      _tag: "ActivityCall",
      activity: "requirement/charge",
      payload: { cents: 100 }
    })
  })
})

describe("combinators union what their parts require", () => {
  it("unions across all, map, and andThen", () => {
    const both = Node.all({ charged: Charge.call({ cents: 1 }), refunded: Refund.call({ cents: 2 }) })
    expectTypeOf<Node.Services<typeof both>>().toEqualTypeOf<ChargeNeeded | RefundNeeded>()

    const mapped = Charge.call({ cents: 1 }).pipe(Node.map((value) => value + 1))
    expectTypeOf<Node.Services<typeof mapped>>().toEqualTypeOf<ChargeNeeded>()

    const sequenced = Charge.call({ cents: 1 }).pipe(Node.andThen(() => Refund.call({ cents: 2 })))
    expectTypeOf<Node.Services<typeof sequenced>>().toEqualTypeOf<ChargeNeeded | RefundNeeded>()
  })

  it("unions BOTH arms of a branch, because both are topology the plan carries", () => {
    const decided = Charge.call({ cents: 1 }).pipe(
      Node.branch({
        if: (value) => value > 0,
        then: () => Refund.call({ cents: 2 }),
        else: () => Audit.call({ note: "declined" })
      })
    )

    expectTypeOf<Node.Services<typeof decided>>().toEqualTypeOf<
      ChargeNeeded | RefundNeeded | AuditNeeded
    >()
  })

  it("unions a catch's failure arm with the graph it protects", () => {
    const recovered = Charge.call({ cents: 1 }).pipe(
      Node.catch({ onFailure: () => Audit.call({ note: "failed" }) })
    )

    expectTypeOf<Node.Services<typeof recovered>>().toEqualTypeOf<ChargeNeeded | AuditNeeded>()
  })

  it("requires nothing of a constant", () => {
    expectTypeOf<Node.Services<ReturnType<typeof Node.succeed<number>>>>().toEqualTypeOf<never>()
  })
})

describe("a flow carries what its body requires", () => {
  const Paying = Flow.make("requirement/execute", {
    payload: { cents: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    body: ({ cents }) => Charge.call({ cents })
  })

  it("puts it in execute, and nowhere a plan is only being described", () => {
    expectTypeOf<Flow.Requirements<typeof Paying>>().toEqualTypeOf<ChargeNeeded>()
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.execute>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime | ChargeNeeded
    >()

    // Neither reading an execution's state nor cancelling one drives a body,
    // and a re-drive runs under the context the flow was REGISTERED with.
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.poll>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime
    >()
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.interrupt>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime
    >()
    expectTypeOf<Effect.Services<ReturnType<typeof Paying.resume>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime
    >()
  })

  it("refuses to run without the implementation layer", () => {
    const engineOnly = Interpreter.layer(Paying).pipe(
      Layer.provideMerge(Activity.layerImplementations),
      Layer.provideMerge(layerMemory)
    )

    // Never invoked: the assertion is that this expression does not compile.
    const unimplemented = () =>
      Effect.runPromise(
        // @ts-expect-error -- the plan names `requirement/charge`, and nothing
        // in this composition implements it.
        Paying.execute({ cents: 100 }, { executionId: "unimplemented" }).pipe(
          Effect.provide(engineOnly)
        )
      )

    expectTypeOf(unimplemented).toBeFunction()
  })

  it("has the requirement erased by the activity's own layer", async () => {
    const wired = Layer.mergeAll(charges, Interpreter.layer(Paying)).pipe(
      Layer.provideMerge(Activity.layerImplementations),
      Layer.provideMerge(layerMemory)
    )
    const run = Paying.execute({ cents: 100 }, { executionId: "implemented" }).pipe(
      Effect.provide(wired)
    )

    expectTypeOf<Effect.Services<typeof run>>().toEqualTypeOf<never>()
    expect(await runPromise(run)).toBe(100)
  })
})

describe("requirements travel the way the plan does", () => {
  const Inner = Flow.make("requirement/inner", {
    payload: { cents: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    body: ({ cents }) => Charge.call({ cents })
  })

  const Middle = Flow.make("requirement/middle", {
    payload: { cents: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    body: ({ cents }) => Inner.call({ cents }).pipe(Node.andThen(() => Audit.call({ note: "ok" })))
  })

  it("propagates transitively through an inline call", () => {
    // The callee's steps join the caller's plan, so the callee's obligations
    // are the caller's, however many levels down they were declared.
    expectTypeOf<Flow.Requirements<typeof Middle>>().toEqualTypeOf<ChargeNeeded | AuditNeeded>()
  })

  it("drops them at a child boundary and at a handoff", () => {
    expectTypeOf<Node.Services<ReturnType<typeof Middle.child>>>().toEqualTypeOf<never>()
    expectTypeOf<Node.Services<ReturnType<typeof Middle.to>>>().toEqualTypeOf<never>()

    const Boundary = Flow.make("requirement/boundary", {
      payload: { cents: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      body: ({ cents }) => Middle.child({ cents })
    })

    expectTypeOf<Flow.Requirements<typeof Boundary>>().toEqualTypeOf<never>()
  })

  it("keeps a self-looping lineage's type finite", () => {
    // A body cannot name its own flow inside its own declaration, so the shape
    // is declared first. It terminates only because `.to()` drops what the next
    // round requires; propagating it would make this alias name itself.
    type SelfFlow = Flow.Flow<
      "requirement/self",
      Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
      typeof Schema.Number,
      typeof Schema.Never,
      ChargeNeeded
    >

    const Self: SelfFlow = Flow.make("requirement/self", {
      payload: { value: Schema.Number, target: Schema.Number },
      success: Schema.Number,
      body: ({ target, value }: { readonly value: number; readonly target: number }) =>
        Charge.call({ cents: value }).pipe(
          Node.branch({
            if: (next) => next >= target,
            then: (next) => Flow.done(next),
            else: (next) => Self.to({ value: next, target })
          })
        )
    })

    expectTypeOf<Flow.Requirements<typeof Self>>().toEqualTypeOf<ChargeNeeded>()
    expectTypeOf<Effect.Services<ReturnType<typeof Self.execute>>>().toEqualTypeOf<
      FlowRuntime.FlowRuntime | ChargeNeeded
    >()
  })
})

describe("system activities require nothing of a caller", () => {
  it("keeps Sleep and WaitFor out of a body's channel", () => {
    expectTypeOf<Node.Services<ReturnType<typeof Sleep.activity.call>>>().toEqualTypeOf<never>()
    expectTypeOf<Node.Services<ReturnType<typeof WaitFor.activity.call>>>().toEqualTypeOf<never>()

    const Waiting = Flow.make("requirement/waiting", {
      payload: { millis: Schema.Number },
      success: Schema.Unknown,
      body: ({ millis }) =>
        Sleep.activity.call({ millis }).pipe(
          Node.andThen(() => WaitFor.activity.call({ name: "approval" }))
        )
    })

    // The engine owns these implementations, so an author cannot be the one who
    // forgot them, and a body that waits pushes nothing onto its callers.
    expectTypeOf<Flow.Requirements<typeof Waiting>>().toEqualTypeOf<never>()
  })
})

describe("toLayer provides the requirement it mints", () => {
  it("answers with the same implementation the name-keyed table holds", async () => {
    const both = Layer.mergeAll(charges, refunds).pipe(
      Layer.provideMerge(Activity.layerImplementations),
      Layer.provideMerge(layerMemory)
    )

    const observed = await runPromise(
      Effect.gen(function*() {
        const charge = yield* Charge.requirement
        const table = yield* Activity.Implementations
        const filed = yield* table.get("requirement/charge")
        return {
          provided: charge.name,
          filed: Option.isSome(filed) ? filed.value.name : undefined,
          same: Option.isSome(filed) && filed.value === charge,
          refund: (yield* Refund.requirement).name
        }
      }).pipe(Effect.provide(both))
    )

    expect(observed).toEqual({
      provided: "requirement/charge",
      filed: "requirement/charge",
      same: true,
      refund: "requirement/refund"
    })
  })

  it("keys the requirement by the activity tag, so two declarations name one slot", () => {
    const again = Activity.make("requirement/charge", {
      payload: { cents: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })

    expect(again.requirement.key).toBe(Charge.requirement.key)
    expect(Charge.requirement.key).toBe("@smthrs/flow-next/Activity/Requirement/requirement/charge")
    // An annotated copy is still the same declaration, and names the same slot.
    expect(Charge.annotate(Activity.CurrentAttempt, 1).requirement.key).toBe(Charge.requirement.key)
  })

  it("still files into the table when no requirement is being collected", async () => {
    // The direct path: a composition that never asks for the tag. Filing is
    // what a driver expanding a persisted plan resolves through, so it happens
    // whether or not the type channel was consulted.
    const audited = audits.pipe(
      Layer.provideMerge(Activity.layerImplementations),
      Layer.provideMerge(layerMemory)
    )

    const filed = await runPromise(
      Effect.gen(function*() {
        const table = yield* Activity.Implementations
        return yield* table.get("requirement/audit")
      }).pipe(Effect.provide(audited))
    )

    expect(Option.isSome(filed) && filed.value.name).toBe("requirement/audit")
  })

  it("skips filing when a composition wired no table, and still provides the tag", async () => {
    const untabled = audits.pipe(Layer.provideMerge(layerMemory))

    const provided = await runPromise(
      Audit.requirement.pipe(Effect.provide(untabled))
    )

    expect(provided.name).toBe("requirement/audit")
  })
})
