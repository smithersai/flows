/**
 * The trampoline on the in-memory engine: a counter that reaches its target by
 * handing off, the derived round identity underneath it, the round budget, and
 * what a handoff to a flow this engine has never been told about does.
 */
import { Activity, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const Increment = Activity.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** The declaration shape every counter in this suite shares. */
type CounterFlow = Flow.Bodied<
  string,
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never
>

/**
 * The declarations a body reaches for by tag. A recursive `.to()` needs the
 * flow inside its own body, which the declaration expression cannot name yet.
 */
const flows = new Map<string, CounterFlow>()

/** A counter that reaches its target one round at a time. */
const counter = (tag: string, maxRounds?: number): CounterFlow =>
  Flow.make(tag, {
    payload: { value: Schema.Number, target: Schema.Number },
    success: Schema.Number,
    ...(maxRounds === undefined ? {} : { maxRounds }),
    body: ({ target, value }: { readonly value: number; readonly target: number }) =>
      Increment.call({ value }).pipe(
        Node.branch({
          if: (next) => next >= target,
          then: (next) => Flow.done(next),
          else: (next) => flows.get(tag)!.to({ value: next, target })
        })
      )
  })

const declare = (tag: string, maxRounds?: number) => {
  const flow = counter(tag, maxRounds)
  flows.set(tag, flow)
  return flow
}

const Counter = declare("trampoline/counter")
const Bounded = declare("trampoline/bounded", 2)
const UnboundedTarget = Flow.make("trampoline/unbounded-target", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Increment.call({ value })
})
const OriginBounded = Flow.make("trampoline/origin-bounded", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  maxRounds: 1,
  body: ({ value }) => UnboundedTarget.to({ value })
})
const ParentActivityDeclaration = Activity.make("trampoline/parent/activity", {
  payload: { target: Schema.Number },
  success: Schema.Number
})
const Parent = Flow.make("trampoline/parent", {
  payload: { target: Schema.Number },
  success: Schema.Number,
  body: (payload) => ParentActivityDeclaration.call(payload)
})

/** Every increment the lineage dispatched, in order. */
const wire = (
  ...registrations: ReadonlyArray<
    Layer.Layer<never, never, FlowRuntime.FlowRuntime | Activity.Implementations>
  >
) => {
  const calls: Array<number> = []
  const layer = Layer.mergeAll(
    Increment.toLayer(({ value }) =>
      Effect.sync(() => {
        calls.push(value)
        return value + 1
      })
    ),
    ...registrations
  ).pipe(
    Layer.provideMerge(Activity.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

describe("FlowEngine.Round", () => {
  it("starts a lineage at ordinal zero under the caller's execution id", () => {
    expect(FlowEngine.Round.initial("run-a")).toEqual({ lineageId: "run-a", ordinal: 0 })
  })

  it("derives the same execution id for the same (lineage, ordinal), and different ids otherwise", async () => {
    const [first, again, later, other] = await runPromise(
      Effect.all([
        FlowEngine.Round.executionId({ lineageId: "run-a", ordinal: 1 }),
        FlowEngine.Round.executionId({ lineageId: "run-a", ordinal: 1 }),
        FlowEngine.Round.executionId({ lineageId: "run-a", ordinal: 2 }),
        FlowEngine.Round.executionId({ lineageId: "run-b", ordinal: 1 })
      ])
    )

    expect(first).toBe(again)
    expect(first).not.toBe(later)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it("advances within an unbounded lineage and within a budget that has room", async () => {
    const unbounded = await runPromise(
      FlowEngine.Round.next({ lineageId: "run-a", ordinal: 0 }, {
        flowName: "f",
        maxRounds: undefined
      })
    )
    expect(unbounded.round).toEqual({ lineageId: "run-a", ordinal: 1 })

    const bounded = await runPromise(
      FlowEngine.Round.next({ lineageId: "run-a", ordinal: 0 }, { flowName: "f", maxRounds: 2 })
    )
    expect(bounded.round.ordinal).toBe(1)
  })

  it("refuses the round that would spend one past the budget", async () => {
    const exit = await runPromise(
      Effect.exit(
        FlowEngine.Round.next({ lineageId: "run-a", ordinal: 1 }, { flowName: "f", maxRounds: 2 })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined
    expect(error).toBeInstanceOf(Flow.MaxRoundsExceeded)
    expect(error instanceof Flow.MaxRoundsExceeded && error.roundOrdinal).toBe(2)
  })
})

describe("a lineage on the memory engine", () => {
  it("tracks nested registrations of the same declaration independently", async () => {
    await runPromise(
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        yield* Effect.scoped(
          Effect.gen(function*() {
            yield* runtime.register(Counter, () => Effect.succeed(0))
            yield* Effect.scoped(runtime.register(Counter, () => Effect.succeed(0)))
          })
        )
      }).pipe(Effect.provide(FlowEngine.layerMemory))
    )
  })

  it("counts to its target across rounds and answers with the lineage's value", async () => {
    const { calls, layer } = wire(Interpreter.layer(Counter))

    const value = await runPromise(
      Counter.execute({ value: 0, target: 3 }, { executionId: "memory-lineage" }).pipe(
        Effect.provide(layer)
      )
    )

    // One increment per round, and the caller sees only the final answer.
    expect(value).toBe(3)
    expect(calls).toEqual([0, 1, 2])
  })

  it("fails the lineage with the typed refusal once the round budget is spent", async () => {
    const { calls, layer } = wire(Interpreter.layer(Bounded))

    const exit = await runPromise(
      Bounded.execute({ value: 0, target: 99 }, { executionId: "memory-bounded" }).pipe(
        Effect.exit,
        Effect.provide(layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
    // Two rounds ran — ordinals 0 and 1 — and the third was refused before it
    // could dispatch anything.
    expect(calls).toEqual([0, 1])
  })

  it("keeps the origin flow's budget across a handoff to another declaration", async () => {
    const { calls, layer } = wire(
      Interpreter.layer(OriginBounded),
      Interpreter.layer(UnboundedTarget)
    )

    const exit = await runPromise(
      OriginBounded.execute({ value: 0 }, { executionId: "memory-origin-budget" }).pipe(
        Effect.exit,
        Effect.provide(layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("MaxRoundsExceeded")
    expect(calls).toEqual([])
  })

  it("follows every round of a lineage executed from a parent flow", async () => {
    const { calls, layer } = wire(
      Interpreter.layer(Counter),
      Layer.mergeAll(
        ParentActivityDeclaration.toLayer(({ target }) =>
          Counter.execute({ value: 0, target }, { executionId: "memory-child-lineage" })
        ),
        Interpreter.layer(Parent)
      ).pipe(
        Layer.provideMerge(Activity.layerImplementations)
      )
    )

    const value = await runPromise(
      Parent.execute({ target: 3 }, { executionId: "memory-parent" }).pipe(
        Effect.provide(layer)
      )
    )

    expect(value).toBe(3)
    expect(calls).toEqual([0, 1, 2])
  })

  it("refuses a handoff to a flow the engine was never told about", async () => {
    const Stranger = Flow.make("trampoline/stranger", {
      payload: { value: Schema.Number },
      success: Schema.Number
    })
    const Orphan = Flow.make("trampoline/orphan", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      body: ({ value }) => Stranger.to({ value })
    })
    const { layer } = wire(Interpreter.layer(Orphan))

    const exit = await runPromise(
      Orphan.execute({ value: 1 }, { executionId: "memory-orphan" }).pipe(
        Effect.exit,
        Effect.provide(layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("is not registered with this engine")
  })
})
