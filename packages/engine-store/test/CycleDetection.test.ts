import { Flow, FlowEngine } from "@smithers/engine"
import { Journal, Ownership, RunStore, TestJournal } from "@smithers/journal"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as RunDriver from "../src/internal/RunDriver.ts"

const TestFlow = Flow.make("CycleDetection/Test", {
  payload: {},
  success: Schema.String
})

const owner: Ownership.OwnerId = {
  hostId: "host-cycles",
  pid: 1,
  nonce: "owner-cycles"
}

const fakeEngine = {} as unknown as FlowEngine.FlowEngine["Service"]

const makeDriver = () =>
  RunDriver.make({
    owner,
    journalSource: "cycles",
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.provide(TestJournal.layer()),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  ) as Effect.Effect<A, E, Exclude<R, Journal.Journal | RunStore.RunStore | Scope.Scope>>

const findCycleDefect = (cause: Cause.Cause<unknown>) => cause.reasons.find(Cause.isDieReason)?.defect

describe("RunDriver cycle detection", () => {
  it("fails a direct self-execute with a 1-element cycle path", async () => {
    const exit = await Effect.runPromise(Effect.exit(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("never runs"))
      return yield* driver.execute(TestFlow, {
        executionId: "self",
        payload: {},
        discard: true,
        parent: { executionId: "self" } as FlowEngine.FlowInstance["Service"]
      })
    }))))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const defect = findCycleDefect(exit.cause)
    expect(defect).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((defect as RunDriver.FlowCycleDetected).path).toEqual(["self"])
  })

  it("executes a legitimate deep parent chain with no cycle", async () => {
    const result = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("ok"))
      const store = yield* RunStore.RunStore

      yield* store.create(
        "root",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "child",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "root" })
      )
      yield* store.create(
        "grandchild",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "child" })
      )

      return yield* driver.execute(TestFlow, {
        executionId: "great-grandchild",
        payload: {},
        discard: true,
        parent: { executionId: "grandchild" } as FlowEngine.FlowInstance["Service"]
      })
    })))

    expect(result).toBeUndefined()
  })

  it("catches a mutual A -> B -> A cycle from the B -> A entry point", async () => {
    const exit = await Effect.runPromise(Effect.exit(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("never runs"))
      const store = yield* RunStore.RunStore

      // A already exists and previously started B as a child.
      yield* store.create(
        "a",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "b",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "a" })
      )

      // Now B attempts to execute A as its child: a cycle.
      return yield* driver.execute(TestFlow, {
        executionId: "a",
        payload: {},
        discard: true,
        parent: { executionId: "b" } as FlowEngine.FlowInstance["Service"]
      })
    }))))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const defect = findCycleDefect(exit.cause)
    expect(defect).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((defect as RunDriver.FlowCycleDetected).path).toEqual(["a", "b"])
  })

  it("catches the same mutual cycle from the other entry point", async () => {
    const exit = await Effect.runPromise(Effect.exit(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("never runs"))
      const store = yield* RunStore.RunStore

      yield* store.create(
        "x",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "y",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "x" })
      )
      yield* store.create(
        "z",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "y" })
      )

      // z attempts to execute x, its grandparent: a cycle.
      return yield* driver.execute(TestFlow, {
        executionId: "x",
        payload: {},
        discard: true,
        parent: { executionId: "z" } as FlowEngine.FlowInstance["Service"]
      })
    }))))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const defect = findCycleDefect(exit.cause)
    expect(defect).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((defect as RunDriver.FlowCycleDetected).path).toEqual(["x", "y", "z"])
  })

  it("terminates on a pre-existing corrupt store cycle instead of hanging", async () => {
    const exit = await Effect.runPromise(Effect.exit(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("ok"))
      const store = yield* RunStore.RunStore

      // A corrupt store: p -> q -> p, unrelated to the target being executed.
      yield* store.create(
        "p",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "q" })
      )
      yield* store.create(
        "q",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "p" })
      )

      return yield* driver.execute(TestFlow, {
        executionId: "unrelated-target",
        payload: {},
        discard: true,
        parent: { executionId: "p" } as FlowEngine.FlowInstance["Service"]
      })
    }))))

    // No cycle involving "unrelated-target" exists, so the walk terminates
    // (rather than looping the p <-> q cycle forever) and the run proceeds.
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
