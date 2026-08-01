import { Flow, FlowEngine } from "@smithers/engine"
import { Journal, Ownership, RunStore, TestJournal } from "@smithers/journal"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
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
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  ) as Effect.Effect<A, E, Exclude<R, Journal.Journal | RunStore.RunStore | Scope.Scope>>

const findCycleFailure = (cause: Cause.Cause<unknown>) => cause.reasons.find(Cause.isFailReason)?.error

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
    const failure = findCycleFailure(exit.cause)
    expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((failure as RunDriver.FlowCycleDetected).code).toBe("flow_cycle_detected")
    expect((failure as RunDriver.FlowCycleDetected)._tag).toBe("flows/engine/FlowCycleDetected")
    expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["self"])
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
    const failure = findCycleFailure(exit.cause)
    expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((failure as RunDriver.FlowCycleDetected).code).toBe("flow_cycle_detected")
    expect((failure as RunDriver.FlowCycleDetected)._tag).toBe("flows/engine/FlowCycleDetected")
    expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["a", "b"])
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
    const failure = findCycleFailure(exit.cause)
    expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((failure as RunDriver.FlowCycleDetected).code).toBe("flow_cycle_detected")
    expect((failure as RunDriver.FlowCycleDetected)._tag).toBe("flows/engine/FlowCycleDetected")
    expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["x", "y", "z"])
  })

  it("catches a diamond cycle reachable only through the second parent edge", async () => {
    const exit = await Effect.runPromise(Effect.exit(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("ok"))
      const store = yield* RunStore.RunStore

      // A previously created C, so C's persisted parent is A. B exists too.
      yield* store.create(
        "a",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "b",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "c",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "a" })
      )

      // B executes C: the row already exists, so this second parent edge is
      // never persisted — it must still be recorded for cycle detection.
      yield* driver.execute(TestFlow, {
        executionId: "c",
        payload: {},
        discard: true,
        parent: { executionId: "b" } as FlowEngine.FlowInstance["Service"]
      })

      // C executes B: a cycle reachable only through the C -> B request edge.
      return yield* driver.execute(TestFlow, {
        executionId: "b",
        payload: {},
        discard: true,
        parent: { executionId: "c" } as FlowEngine.FlowInstance["Service"]
      })
    }))))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const failure = findCycleFailure(exit.cause)
    expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
    expect((failure as RunDriver.FlowCycleDetected).path).toEqual(["b", "c"])
  })

  it("admits a legitimate cycle-free fan-in diamond (issue #37)", async () => {
    const result = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const driver = yield* makeDriver()
      yield* driver.register(TestFlow, () => Effect.succeed("ok"))
      const store = yield* RunStore.RunStore

      // Root fans out to A and B; both converge on C. Two parents, no cycle:
      // an over-reporting detector regression must not refuse this shape.
      yield* store.create(
        "diamond-root",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "diamond-a",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "diamond-root" })
      )
      yield* store.create(
        "diamond-b",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, parentExecutionId: "diamond-root" })
      )

      // A creates C (persisted first-parent edge), then B converges on C
      // (request-only second-parent edge). Both must succeed.
      const first = yield* Effect.exit(driver.execute(TestFlow, {
        executionId: "diamond-c",
        payload: {},
        discard: true,
        parent: { executionId: "diamond-a" } as FlowEngine.FlowInstance["Service"]
      }))
      const second = yield* Effect.exit(driver.execute(TestFlow, {
        executionId: "diamond-c",
        payload: {},
        discard: true,
        parent: { executionId: "diamond-b" } as FlowEngine.FlowInstance["Service"]
      }))
      const row = yield* store.get("diamond-c")
      return { first, second, status: row.status }
    })))

    expect(Exit.isSuccess(result.first)).toBe(true)
    expect(Exit.isSuccess(result.second)).toBe(true)
    expect(result.status).toBe("completed")
  })

  it("rejects a concurrently formed mutual cycle instead of admitting both edges (issue #29)", async () => {
    const result = await Effect.runPromise(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      // Force an async boundary inside every parent-chain read so the two
      // fibers' cycle checks provably interleave: without serialization both
      // checks complete before either edge is recorded (the TOCTOU race).
      const yieldingStore: RunStore.Service = {
        ...store,
        get: (runId) => Effect.yieldNow.pipe(Effect.andThen(store.get(runId)))
      }
      const driver = yield* makeDriver().pipe(
        Effect.provideService(RunStore.RunStore, yieldingStore)
      )
      yield* driver.register(TestFlow, () => Effect.succeed("ok"))

      yield* store.create(
        "race-a",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )
      yield* store.create(
        "race-b",
        JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
      )

      // Fiber 1: A executes B. Fiber 2: B executes A. Together they close a
      // cycle; exactly one must be refused.
      const exits = yield* Effect.all([
        Effect.exit(driver.execute(TestFlow, {
          executionId: "race-b",
          payload: {},
          discard: true,
          parent: { executionId: "race-a" } as FlowEngine.FlowInstance["Service"]
        })),
        Effect.exit(driver.execute(TestFlow, {
          executionId: "race-a",
          payload: {},
          discard: true,
          parent: { executionId: "race-b" } as FlowEngine.FlowInstance["Service"]
        }))
      ], { concurrency: "unbounded" })
      return { exits }
    })))

    const failures = result.exits.filter(Exit.isFailure)
    expect(failures).toHaveLength(1)
    const failure = findCycleFailure(failures[0]!.cause)
    expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
  })

  it(
    "rejects a mutual cycle formed across two driver instances over one shared store (issue #40)",
    async () => {
      const result = await Effect.runPromise(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        // Force an async boundary inside every parent-chain read so the two
        // drivers' cycle checks provably interleave: each driver has its own
        // in-process cycle gate, so nothing in-process serializes them.
        const yieldingStore: RunStore.Service = {
          ...store,
          get: (runId) => Effect.yieldNow.pipe(Effect.andThen(store.get(runId)))
        }
        // Two owner processes over the same shared RunStore/state.
        const driverOne = yield* makeDriver().pipe(
          Effect.provideService(RunStore.RunStore, yieldingStore)
        )
        const driverTwo = yield* makeDriver().pipe(
          Effect.provideService(RunStore.RunStore, yieldingStore)
        )
        yield* driverOne.register(TestFlow, () => Effect.succeed("ok"))
        yield* driverTwo.register(TestFlow, () => Effect.succeed("ok"))

        yield* store.create(
          "xrace-a",
          JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
        )
        yield* store.create(
          "xrace-b",
          JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} })
        )

        // Worker 1: A executes B. Worker 2: B executes A. Together they
        // close a cycle; exactly one must be refused, and neither may
        // deadlock on mutual coordinator awaits.
        const exits = yield* Effect.all([
          Effect.exit(driverOne.execute(TestFlow, {
            executionId: "xrace-b",
            payload: {},
            discard: true,
            parent: { executionId: "xrace-a" } as FlowEngine.FlowInstance["Service"]
          })),
          Effect.exit(driverTwo.execute(TestFlow, {
            executionId: "xrace-a",
            payload: {},
            discard: true,
            parent: { executionId: "xrace-b" } as FlowEngine.FlowInstance["Service"]
          }))
        ], { concurrency: "unbounded" })
        return { exits }
      })))

      const failures = result.exits.filter(Exit.isFailure)
      expect(failures).toHaveLength(1)
      const failure = findCycleFailure(failures[0]!.cause)
      expect(failure).toBeInstanceOf(RunDriver.FlowCycleDetected)
    },
    10_000
  )

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
