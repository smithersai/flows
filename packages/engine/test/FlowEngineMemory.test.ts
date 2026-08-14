// Deep reviewed and polished by a human on 2026-08-10.

import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow-next"
import { Node } from "@smthrs/plan-next"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { runPromise } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

describe("memory engine execution surface", () => {
  effect("dies when executing a flow that was never registered", () => {
    const flow = Flow.make("Memory/unregistered", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("is not registered")
    }).pipe(Effect.provide(FlowEngine.layerMemory))
  })

  effect("polls None for an unknown execution id", () => {
    const flowActionDeclaration = Action.make("Memory/poll-none/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/poll-none", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.void), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(Option.isNone(yield* flow.poll("never-started"))).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("discard execution returns the execution id without awaiting the result", () => {
    const flowActionDeclaration = Action.make("Memory/discard/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Memory/discard", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.succeed(7)), Interpreter.layer(flow))
      .pipe(
        Layer.provideMerge(Action.layerImplementations)
      ).pipe(
        Layer.provideMerge(FlowEngine.layerMemory)
      )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "x" }, { executionId: "run-d", discard: true })
      expect(executionId).toBe("run-d")
      let polled = yield* flow.poll("run-d")
      while (Option.isNone(polled) || polled.value._tag !== "Complete") {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-d")
      }
      expect(polled.value._tag).toBe("Complete")
    }).pipe(Effect.provide(layer))
  })

  effect("interruptUnsafe interrupts the fiber established before discard returns", () => {
    const flowActionDeclaration = Action.make("Memory/interrupt-unsafe/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/interrupt-unsafe", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.never), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-i", discard: true })
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.interruptUnsafe(flow, "run-i")
      const result = yield* flow.poll("run-i").pipe(Effect.exit)
      // A discard result is observable only after `resume` has installed the
      // execution fiber; unsafe interruption can therefore always target it.
      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) && String(result.cause)).toContain("Interrupt")
      // interrupting an unknown id is a no-op
      yield* flow.interrupt("missing")
    }).pipe(Effect.provide(layer))
  })
})

describe("compensable snapshot boundary", () => {
  effect("dies when a compensable action runs without a SnapshotBoundary", () => {
    const step = Action.make({
      name: "Memory/compensable-missing-boundary",
      tier: "compensable",
      success: Schema.Void,
      execute: Effect.void
    })
    const flowActionDeclaration = Action.make("Memory/compensable-missing/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/compensable-missing", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => step), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("requires SnapshotBoundary")
    }).pipe(Effect.provide(layer))
  })

  effect("snapshots before each attempt, restores before retry, and diffs after run", () => {
    const events: Array<string> = []
    let attempts = 0
    const step = Action.make({
      name: "Memory/compensable-retry",
      tier: "compensable",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.suspend(() => {
        attempts++
        events.push(`execute:${attempts}`)
        return attempts === 1 ? Effect.fail("try-again") : Effect.succeed(attempts)
      })
    })
    const flowActionDeclaration = Action.make("Memory/compensable-retry/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Memory/compensable-retry", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const boundary = FlowEngine.SnapshotBoundary.of({
      snapshot: (options) => Effect.sync(() => (events.push(`snapshot:${options.attempt}`), "snap")),
      restore: (snapshot, options) =>
        Effect.sync(() => void events.push(`restore:${String(snapshot)}:${options.attempt}`)),
      diff: (snapshot, options) =>
        Effect.sync(() => {
          events.push(`diff:${String(snapshot)}:${options.attempt}`)
          return Option.none()
        })
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Action.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary)(boundary))
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(2)
      expect(events).toEqual([
        "snapshot:1",
        "execute:1",
        "diff:snap:1",
        "restore:snap:2",
        "snapshot:2",
        "execute:2",
        "diff:snap:2"
      ])
    }).pipe(Effect.provide(layer))
  })
})

describe("flow definition surface", () => {
  effect("annotate and annotateMerge attach context without changing identity", () => {
    const Marker = Context.Service<{ readonly _: "Marker" }, string>("Memory/Marker")
    const Other = Context.Service<{ readonly _: "Other" }, number>("Memory/Other")
    const flow = Flow.make("Memory/annotations", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const annotated = flow.annotate(Marker, "hello")
    const merged = annotated.annotateMerge(Context.make(Other, 4))
    return Effect.sync(() => {
      expect(annotated._tag).toBe("Memory/annotations")
      expect(Context.get(annotated.annotations as Context.Context<never>, Marker as never)).toBe("hello")
      expect(Context.get(merged.annotations as Context.Context<never>, Marker as never)).toBe("hello")
      expect(Context.get(merged.annotations as Context.Context<never>, Other as never)).toBe(4)
    })
  })

  effect("executionId falls back to the ambient source when the flow has no idempotency key", () => {
    const flow = Flow.make("Memory/no-key", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    return Effect.gen(function*() {
      // The default source derives from the tag and the payload, so a flow
      // that declares no key still names its execution.
      const first = yield* flow.executionId({ id: "x" })
      const second = yield* flow.executionId({ id: "x" })
      const other = yield* flow.executionId({ id: "y" })
      expect(first).toBe(second)
      expect(first).not.toBe(other)
      const hosted = yield* flow.executionId({ id: "x" }).pipe(
        Effect.provide(Flow.layerExecutionIds({ mint: () => Effect.succeed("host-selected") }))
      )
      expect(hosted).toBe("host-selected")
    })
  })

  effect("runs rollbacks only on failure exits", () => {
    const rolledBack: Array<string> = []
    const flowFailActionDeclaration = Action.make("Memory/rollback-fail/action", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const flowFail = Flow.make("Memory/rollback-fail", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      body: (payload) => flowFailActionDeclaration.call(payload)
    })
    const flowOkActionDeclaration = Action.make("Memory/rollback-ok/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flowOk = Flow.make("Memory/rollback-ok", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => flowOkActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      Layer.mergeAll(
        flowFailActionDeclaration.toLayer(() =>
          Effect.gen(function*() {
            yield* Flow.withRollback(
              Effect.succeed("resource"),
              (value) => Effect.sync(() => void rolledBack.push(`undo:${value}`))
            )
            return yield* Effect.fail("boom")
          })
        ),
        Interpreter.layer(flowFail)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      ),
      Layer.mergeAll(
        flowOkActionDeclaration.toLayer(() =>
          Flow.withRollback(
            Effect.succeed("kept"),
            (value) => Effect.sync(() => void rolledBack.push(`undo:${value}`))
          )
        ),
        Interpreter.layer(flowOk)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations)
      )
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const exit = yield* flowFail.execute({ id: "x" }, { executionId: "run-f" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* flowOk.execute({ id: "x" }, { executionId: "run-o" })).toBe("kept")
      expect(rolledBack).toEqual(["undo:resource"])
    }).pipe(Effect.provide(layer))
  })

  effect("addFinalizer observes the flow's final exit", () => {
    const exits: Array<string> = []
    const flowActionDeclaration = Action.make("Memory/finalizer/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Memory/finalizer", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          yield* Flow.addFinalizer((exit) => Effect.sync(() => void exits.push(exit._tag)))
          return 3
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(3)
      expect(exits).toEqual(["Success"])
    }).pipe(Effect.provide(layer))
  })

  effect("provideScope keeps scoped resources open for the flow lifetime", () => {
    const events: Array<string> = []
    const flowActionDeclaration = Action.make("Memory/scoped/action", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const flow = Flow.make("Memory/scoped", {
      payload: { id: Schema.String },
      success: Schema.Void,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Flow.provideScope(
          Effect.acquireRelease(
            Effect.sync(() => void events.push("acquire")),
            () => Effect.sync(() => void events.push("release"))
          )
        ).pipe(Effect.tap(() => Effect.sync(() => void events.push("body-done"))), Effect.asVoid)
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run" })
      expect(events[0]).toBe("acquire")
      expect(events).toContain("release")
      expect(events.indexOf("body-done")).toBeLessThan(events.indexOf("release"))
    }).pipe(Effect.provide(layer))
  })

  effect("child flow completion propagates into the parent flow", () => {
    const childActionDeclaration = Action.make("Memory/child/action", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const child = Flow.make("Memory/child", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: (payload) => childActionDeclaration.call(payload)
    })
    const parentActionDeclaration = Action.make("Memory/parent/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const parent = Flow.make("Memory/parent", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => parentActionDeclaration.call(payload)
    })
    // The parent's implementation executes the child, so the child's wiring goes
    // UNDER the parent's rather than beside it: that is what answers the child
    // flow's requirement where the parent's implementation asks for it.
    const layer = Layer.mergeAll(
      parentActionDeclaration.toLayer(() => child.execute({ n: 1 }, { executionId: "child-run" })),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(
          childActionDeclaration.toLayer((payload) => Effect.succeed(payload.n + 1)),
          Interpreter.layer(child)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      ),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* parent.execute({ id: "x" }, { executionId: "parent-run" })).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("child flow failures carry their cause to the parent", () => {
    const childActionDeclaration = Action.make("Memory/child-fail/action", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })
    const child = Flow.make("Memory/child-fail", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => childActionDeclaration.call(payload)
    })
    const parentActionDeclaration = Action.make("Memory/parent-fail/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const parent = Flow.make("Memory/parent-fail", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => parentActionDeclaration.call(payload)
    })
    // The parent's implementation executes the child, so the child's wiring goes
    // UNDER the parent's rather than beside it: that is what answers the child
    // flow's requirement where the parent's implementation asks for it.
    const layer = Layer.mergeAll(
      parentActionDeclaration.toLayer(() => child.execute({ n: 1 }, { executionId: "child-run-f" })),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(
          childActionDeclaration.toLayer(() => Effect.fail("child-broke")),
          Interpreter.layer(child)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      ),
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* parent.execute({ id: "x" }, { executionId: "parent-run-f" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("child-broke")
    }).pipe(Effect.provide(layer))
  })
})
