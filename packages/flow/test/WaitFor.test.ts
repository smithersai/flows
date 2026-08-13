/**
 * The system wait activity: what it puts in a plan, how it parks, how the
 * ordinary deferred completion path resumes it, and what a settled wait does on
 * replay.
 */
import { Activity, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const pollComplete = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, never, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 20 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

/** The step before a wait, so a replay that re-ran it would be visible. */
const Mark = Activity.make("waitFor/mark", {
  payload: { label: Schema.String },
  success: Schema.String
})

const marks: Array<string> = []

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Activity.Implementations> = Layer.empty
): Layer.Layer<FlowRuntime.FlowRuntime | Activity.Implementations> =>
  Layer.mergeAll(
    WaitFor.layer,
    Mark.toLayer(({ label }) =>
      Effect.sync(() => {
        marks.push(label)
        return label
      })
    ),
    registration
  ).pipe(
    Layer.provideMerge(Activity.layerImplementations),
    Layer.provideMerge(layerMemory)
  )

/** A host flow for interpretations driven outside a registered execution. */
const Host = Flow.make("waitFor/host", { payload: {}, body: () => Node.succeed(undefined) })

/** A second flow, so a token can name the running execution under a foreign flow. */
const Other = Flow.make("waitFor/other", { payload: {}, body: () => Node.succeed(undefined) })

const drive = <A, E>(
  effect: Effect.Effect<A, E, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Activity.Implementations>,
  instance: FlowRuntime.FlowInstance["Service"]
): Promise<A> =>
  runPromise(
    effect.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  )

const refusal = async (node: Node.Node<unknown, unknown>): Promise<unknown> => {
  const exit = await drive(
    Effect.exit(Interpreter.interpret(node)),
    makeInstance(Host, "waitFor-refusal")
  )
  expect(Exit.isFailure(exit)).toBe(true)
  return Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
}

describe("WaitFor as a plan node", () => {
  const Gated = Flow.make("waitFor/plan", {
    payload: { name: Schema.String },
    success: Schema.Json,
    body: ({ name }) => WaitFor.activity.call({ name })
  })

  it("is an ordinary declared activity", () => {
    expect(WaitFor.tag).toBe("system/wait-for")
    expect(WaitFor.activity.name).toBe("system/wait-for")
    expect(WaitFor.activity.tier).toBe("sealed")
  })

  it("names the deferred a resolver completes", () => {
    expect(WaitFor.deferred("approval").name).toBe("WaitFor/approval")
  })

  it("appears in a built graph as a keyed activity-call node", () => {
    const graph = Graph.build(Gated, { name: "approval" })
    const node = Graph.nodes(graph).find((observed) => observed.kind === "ActivityCall")

    expect(graph.diagnostics).toEqual([])
    expect(node?.id).toBe("root.flow")
    expect(node?.ast).toEqual({
      _tag: "ActivityCall",
      activity: "system/wait-for",
      payload: { name: "approval" }
    })
    expect(node?.payload).toEqual({ name: "approval" })
    expect(Graph.drafts(graph).map((draft) => draft.id)).toContain("root.flow")
    expect(node?.draft.material.body).toMatchObject({
      _tag: "ActivityCall",
      activity: "system/wait-for",
      tier: "sealed"
    })
  })
})

describe("WaitFor parks", () => {
  effect("parks until the deferred is completed, then settles with the resolved value", () => {
    marks.length = 0
    const Gated = Flow.make("waitFor/gated", {
      payload: { name: Schema.String },
      success: Schema.Json,
      body: ({ name }) =>
        Mark.call({ label: "before" }).pipe(
          Node.andThen(() => WaitFor.activity.call({ name }))
        )
    })
    const executionId = "waitFor-gated"
    return Effect.gen(function*() {
      yield* Gated.execute({ name: "approval" }, { executionId, discard: true })
      yield* Effect.yieldNow
      const suspended = yield* Gated.poll(executionId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      expect(marks).toEqual(["before"])

      // Resolution is the ordinary durable deferred completion path: a token,
      // and `DurableDeferred.succeed`.
      const gate = WaitFor.deferred("approval")
      const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Gated, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })

      const result = yield* pollComplete(Gated.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toEqual({ approved: true })
      }
      // The step before the wait was journaled: the resumed round replayed its
      // recorded outcome instead of running it again.
      expect(marks).toEqual(["before"])
    }).pipe(Effect.provide(wired(Interpreter.layer(Gated))))
  })

  effect("declares the event waiting vocabulary with the wake token", () => {
    const instance = makeInstance(Host, "waitFor-annotation")
    return Effect.gen(function*() {
      const result = yield* Flow.intoResult(Interpreter.interpret(WaitFor.activity.call({ name: "gate" })))
      expect(result._tag).toBe("Suspended")
      expect(instance.suspended).toBe(true)
      expect(instance.waiting).toEqual({
        reason: "event",
        token: DurableDeferred.tokenFromExecutionId(WaitFor.deferred("gate"), {
          flow: Host,
          executionId: "waitFor-annotation"
        })
      })
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  })
})

describe("WaitFor replays", () => {
  it("does not park again once its result is recorded", async () => {
    const instance = makeInstance(Host, "waitFor-replay")
    await drive(
      Effect.gen(function*() {
        const gate = WaitFor.deferred("recorded")
        const token = DurableDeferred.tokenFromExecutionId(gate, {
          flow: Host,
          executionId: "waitFor-replay"
        })
        yield* DurableDeferred.succeed(gate, { token, value: "already" })

        const interpretation = yield* Interpreter.interpret(WaitFor.activity.call({ name: "recorded" }))
        expect(interpretation.value).toBe("already")
      }),
      instance
    )
    expect(instance.suspended).toBe(false)
    // The persisted result consumes the declared classification, so a later
    // suspension parks under its own reason.
    expect(instance.waiting).toBeUndefined()
  })

  it("awaits the wait point an absolute token names", async () => {
    const instance = makeInstance(Host, "waitFor-token")
    await drive(
      Effect.gen(function*() {
        const gate = WaitFor.deferred("by-token")
        const token = DurableDeferred.tokenFromExecutionId(gate, {
          flow: Host,
          executionId: "waitFor-token"
        })
        yield* DurableDeferred.succeed(gate, { token, value: ["resolved"] })

        const interpretation = yield* Interpreter.interpret(WaitFor.activity.call({ token }))
        expect(interpretation.value).toEqual(["resolved"])
      }),
      instance
    )
    expect(instance.suspended).toBe(false)
  })
})

describe("WaitFor refusals", () => {
  it("refuses a payload that names no wait point", async () => {
    expect(await refusal(WaitFor.activity.call({}))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/WaitForRequestInvalid",
        code: "missing_target",
        message: expect.stringContaining("neither")
      }
    })
  })

  it("refuses a payload that names both a token and a name", async () => {
    expect(
      await refusal(WaitFor.activity.call({ name: "gate", token: "anything" }))
    ).toMatchObject({
      error: {
        _tag: "@smthrs/flow/WaitForRequestInvalid",
        code: "ambiguous_target",
        message: expect.stringContaining("one wait point")
      }
    })
  })

  it("refuses a token that is not a durable deferred token", async () => {
    expect(await refusal(WaitFor.activity.call({ token: "not a token" }))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/WaitForRequestInvalid",
        code: "malformed_token"
      }
    })
  })

  it("refuses a token addressed to another execution", async () => {
    const foreign = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("elsewhere"), {
      flow: Host,
      executionId: "some-other-execution"
    })

    expect(await refusal(WaitFor.activity.call({ token: foreign }))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/WaitForRequestInvalid",
        code: "foreign_execution",
        message: expect.stringContaining("some-other-execution")
      }
    })
  })

  it("refuses a same-execution token addressed to another flow", async () => {
    // Completion is recorded against (flow name, execution id, deferred name),
    // so a token minted for another flow would be satisfied under that flow
    // while this one reads under its own: a park nothing ever wakes.
    const foreign = DurableDeferred.tokenFromExecutionId(WaitFor.deferred("elsewhere"), {
      flow: Other,
      executionId: "waitFor-refusal"
    })

    expect(await refusal(WaitFor.activity.call({ token: foreign }))).toMatchObject({
      error: {
        _tag: "@smthrs/flow/WaitForRequestInvalid",
        code: "foreign_execution",
        message: expect.stringContaining("waitFor/other")
      }
    })
  })
})
