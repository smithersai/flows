/**
 * A `.child()` boundary driven by the real engine: the child is its own
 * execution, opened with the parent instance in hand — which is what
 * `RunDriver` turns into a `flows_run_parents` edge — and the nesting the edge
 * stands for is genuine, so the parent's interruption and the child's
 * suspension travel between them.
 */
import { Activity, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const Bump = Activity.make("boundary/bump", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Child = Flow.make("boundary/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Bump.call({ value })
})

const Parent = Flow.make("boundary/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Child.child({ value }).pipe(Node.map((settled) => settled * 10))
})

/** The node id the boundary in `Parent`'s body is recorded under. */
const boundaryNode = "root.flow.map"

/**
 * An engine over a scripted low-level implementation, recording what every
 * execution request carried. `options.parent` is the whole point: a durable
 * driver records exactly that pair as the run-parent edge before it creates the
 * child's run row.
 */
const scripted = (result: Flow.Result<unknown, unknown>) => {
  const requests: Array<{ readonly executionId: string; readonly parent: string | undefined }> = []
  const interrupts: Array<string> = []
  const engine = FlowEngine.makeUnsafe({
    register: () => Effect.void,
    execute: ((_flow: Flow.Any, options: {
      readonly executionId: string
      readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
    }) =>
      Effect.sync(() => {
        requests.push({ executionId: options.executionId, parent: options.parent?.executionId })
        return result
      })) as never,
    poll: () => Effect.succeedNone,
    interrupt: (_flow, executionId) => Effect.sync(() => void interrupts.push(executionId)),
    interruptUnsafe: () => Effect.void,
    resume: () => Effect.void,
    activityExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void })),
    deferredResult: () => Effect.succeedNone,
    deferredDone: () => Effect.void,
    scheduleClock: () => Effect.void
  })
  return { engine, interrupts, requests }
}

/**
 * Drives one body against a scripted engine, as a handler under `parent` would.
 * A suspension interrupts the running fiber rather than answering, so the exit
 * is observed from outside it.
 */
const drive = (
  engine: FlowRuntime.FlowRuntime["Service"],
  instance: FlowRuntime.FlowInstance["Service"]
): Promise<Exit.Exit<Interpreter.Interpretation, unknown>> =>
  runPromise(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        Interpreter.interpret(Parent, { value: 4 }).pipe(
          Effect.scoped,
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provideService(FlowRuntime.FlowRuntime, engine),
          Effect.provide(Activity.layerImplementations)
        )
      )
      return yield* Fiber.await(fiber)
    })
  )

/**
 * The real in-memory engine, with the callee registered as its own flow and the
 * activity it calls recording every dispatch.
 */
const live = () => {
  const calls: Array<string> = []
  const layer = Layer.mergeAll(
    Bump.toLayer(({ value }) =>
      Effect.sync(() => {
        calls.push(`bump:${value}`)
        return value + 1
      })
    ),
    Interpreter.layer(Child),
    Interpreter.layer(Parent)
  ).pipe(
    Layer.provideMerge(Activity.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

describe("a child boundary on the real engine", () => {
  it("opens the child with the parent instance, under an id derived from parent and node", async () => {
    const { engine, requests } = scripted(new Flow.Complete({ exit: Exit.succeed(5) }))
    const instance = FlowEngine.makeInstance(Parent, "boundary-parent")

    const exit = await drive(engine, instance)

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(Exit.isSuccess(exit) && exit.value.value).toBe(50)
    // One request, naming the parent: a durable driver records
    // (child, parent) as the run-parent edge before the child's run row exists.
    expect(requests).toEqual([{
      executionId: await runPromise(Interpreter.childExecutionId("boundary-parent", boundaryNode, Child._tag, {
        value: 4
      })),
      parent: "boundary-parent"
    }])
  })

  it("suspends the parent when the child suspends", async () => {
    const { engine, requests } = scripted(new Flow.Suspended({}))
    const instance = FlowEngine.makeInstance(Parent, "boundary-suspended")

    const exit = await drive(engine, instance)

    // Suspension interrupts the running fiber rather than answering, which is
    // how the engine parks a parent behind its child.
    expect(Exit.isSuccess(exit)).toBe(false)
    expect(instance.suspended).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it("interrupts the child by its derived id when the parent is torn down interrupted", async () => {
    const { engine, interrupts } = scripted(new Flow.Suspended({}))
    const instance = FlowEngine.makeInstance(Parent, "boundary-interrupted")
    instance.interrupted = true

    await drive(engine, instance)

    expect(interrupts).toEqual([
      await runPromise(Interpreter.childExecutionId("boundary-interrupted", boundaryNode, Child._tag, { value: 4 }))
    ])
  })

  it("runs the child as a separate registered execution on the real engine", async () => {
    const { calls, layer } = live()

    const value = await runPromise(
      Parent.execute({ value: 4 }, { executionId: "boundary-live" }).pipe(Effect.provide(layer))
    )

    expect(value).toBe(50)
    expect(calls).toEqual(["bump:4"])
  })

  it("re-derives the same child id when the parent body is replayed, so the child runs once", async () => {
    const { calls, layer } = live()

    // Asking the engine for the same parent execution id twice answers from the
    // settled parent without planning anything, so it can never observe a
    // minted child id. Re-driving the BODY under one instance is the replay
    // that reaches the boundary node a second time.
    const replay = await runPromise(
      Effect.gen(function*() {
        const instance = FlowEngine.makeInstance(Parent, "boundary-replay")
        const drive = Interpreter.interpret(Parent, { value: 4 }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
        const first = yield* drive
        const second = yield* drive
        return [first.value, second.value]
      }).pipe(Effect.scoped, Effect.provide(layer))
    )

    expect(replay).toEqual([50, 50])
    expect(calls).toEqual(["bump:4"])
  })

  it("derives injective ids from the canonical parent, node, callee, and payload tuple", async () => {
    const derive = (parent: string, node: string, callee: string, payload: unknown) =>
      runPromise(Interpreter.childExecutionId(parent, node, callee, payload))
    const base = await derive("a/child/b", "c", "boundary/child", { b: 2, a: 1 })

    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await derive("a", "b/child/c", "boundary/child", { a: 1, b: 2 })).not.toBe(base)
    expect(await derive("a/child/b", "c", "boundary/other", { a: 1, b: 2 })).not.toBe(base)
    expect(await derive("a/child/b", "c", "boundary/child", { a: 1, b: 3 })).not.toBe(base)
    expect(await derive("a/child/b", "c", "boundary/child", { a: 1, b: 2 })).toBe(base)
  })
})
