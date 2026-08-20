/**
 * The QuickJS-WASM binding's own edges.
 *
 * The contract both bindings must answer identically lives in `Sandbox.test.ts`
 * and runs there against each of them. What is pinned here is what only the
 * separate-realm binding has: the ceilings it alone enforces, the shapes that
 * cross the WebAssembly boundary, and the failure modes of the realm itself.
 */
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"

const flows: Readonly<Record<string, Cell.FlowProjection>> = {
  "fs/list": new Cell.FlowProjection({
    name: "fs/list",
    description: "List a directory.",
    capabilities: ["fs:read:**"],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })
}

const succeeds: Sandbox.Handler = () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))

/** Runs one cell and reports the whole `Exit`, so a defect is observable too. */
const evaluate = (
  text: string,
  options: {
    readonly call?: Sandbox.Handler | undefined
    readonly limits?: Sandbox.Limits | undefined
    readonly state?: Schema.Json | undefined
  } = {}
): Promise<Exit.Exit<Cell.Outcome, Sandbox.SandboxError | Error>> =>
  Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    return yield* Effect.exit(sandbox.evaluate({
      cell: Cell.source(text),
      flows,
      call: options.call ?? succeeds,
      state: options.state,
      limits: options.limits
    }))
  }).pipe(Effect.runPromise)

/** Runs one cell that is expected to settle with an outcome rather than fail. */
const outcomeOf = async (
  text: string,
  options: Parameters<typeof evaluate>[1] = {}
): Promise<Cell.Outcome> => {
  const exit = await evaluate(text, options)
  if (Exit.isFailure(exit)) throw new Error(`expected an outcome, got: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

/** Runs one cell and reports the binding's own typed failure as data. */
const resultOf = (
  text: string,
  options: Parameters<typeof evaluate>[1] = {}
) =>
  Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    return yield* Effect.result(sandbox.evaluate({
      cell: Cell.source(text),
      flows,
      call: options.call ?? succeeds,
      state: options.state,
      limits: options.limits
    }))
  }).pipe(Effect.runPromise)

describe("QuickJSSandbox limits", () => {
  it("runs at exactly the minimum heap and refuses the byte below it", async () => {
    const atMinimum = await outcomeOf(`return { intent: "complete", output: "ok" }`, {
      limits: { memoryBytes: Sandbox.minimumMemoryBytes }
    })
    expect(atMinimum).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "ok" } })

    const below = await resultOf(`return { intent: "complete", output: "ok" }`, {
      limits: { memoryBytes: Sandbox.minimumMemoryBytes - 1 }
    })
    expect(below).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "unsupported",
        message: `The memoryBytes limit must be a safe integer of at least ${Sandbox.minimumMemoryBytes} bytes`
      }
    })
  })

  it("stops an unbounded allocation at the heap ceiling while its step budget is untouched", async () => {
    // Memory before steps: the step budget is effectively infinite, so the only
    // thing that can end this cell is the heap.
    const outcome = await outcomeOf(
      `const held = []
       for (let index = 0; index < 1000000; index++) held.push({ index: index, pad: "x".repeat(64) })
       return { intent: "complete", output: String(held.length) }`,
      { limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER } }
    )

    expect(outcome).toStrictEqual(new Cell.Raised({ name: "InternalError", message: "out of memory" }))
  }, 60_000)

  it("stops a cell that never returns at the step ceiling while its heap is untouched", async () => {
    // Steps before memory: the mirror of the case above. The loop allocates
    // nothing, so only the interpreter budget can stop it.
    const outcome = await outcomeOf(
      `let total = 0
       while (true) total = total + 1`,
      { limits: { steps: 100, memoryBytes: Sandbox.defaultLimits.memoryBytes, timeMs: 60_000 } }
    )

    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its limit of 100 interpreter steps"
      })
    )
  })

  it("stops a cell that never returns at the compute clock when no other ceiling can", async () => {
    // The budget is a whole second because the clock starts before the realm
    // does: a ceiling tight enough to expire during the binding's own setup is
    // the separate case two tests below.
    const outcome = await outcomeOf(
      `let total = 0
       while (true) total = total + 1`,
      { limits: { timeMs: 1000, steps: Number.MAX_SAFE_INTEGER, totalMs: 30_000 } }
    )

    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its wall-clock limit of 1000 milliseconds"
      })
    )
  }, 60_000)

  it("charges the prelude to the step budget, so a one-step frame never reaches its cell", async () => {
    // The catalog and the previous frame's state are installed by interpreted
    // code, so a budget this small is spent before the cell's first statement.
    const state: Record<string, number> = {}
    for (let index = 0; index < 4000; index++) state[`key${index}`] = index

    const outcome = await outcomeOf(`return { intent: "complete", output: "unreachable" }`, {
      limits: { steps: 1 },
      state
    })

    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its limit of 1 interpreter steps"
      })
    )
  })

  it("fails the frame when the prelude itself cannot fit the heap", async () => {
    // A prelude that cannot be installed is the binding failing at its job, not
    // the cell failing at its own, so it travels in the error channel.
    const result = await resultOf(`return { intent: "complete", output: "unreachable" }`, {
      limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER },
      state: { blob: "y".repeat(3 * 1024 * 1024) }
    })

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "flows/harness/SandboxError",
        code: "runtime_failed",
        message: "The sandbox prelude failed to install",
        cause: { name: "InternalError", message: "out of memory" }
      }
    })
  })

  it("lets a cell that settles synchronously through a zero whole-evaluation ceiling", async () => {
    // `totalMs` bounds waiting, and this cell never waits: it is finished
    // before the ceiling has anything to interrupt.
    const outcome = await outcomeOf(`return { intent: "complete", output: "instant" }`, {
      limits: { totalMs: 0 }
    })

    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "instant" } })
  })

  it("dies instead of reporting a ceiling when a budget of zero stops the prelude's own scaffolding", async () => {
    // Recorded, not endorsed. A zero budget interrupts the property helper the
    // binding evaluates before any cell code exists, and that failure escapes
    // the acquire as a defect rather than as `limit_exceeded`. The runtime is
    // still torn down, which the following frames in this file prove.
    for (const limits of [{ steps: 0 }, { timeMs: 0 }]) {
      const exit = await evaluate(`return { intent: "complete", output: "unreachable" }`, { limits })
      expect(Exit.isFailure(exit), JSON.stringify(limits)).toBe(true)
      expect(Cause.pretty((exit as Exit.Failure<never, never>).cause)).toContain("interrupted")
    }
  })
})

describe("QuickJSSandbox realm", () => {
  it("projects a thrown non-object into a stable raised outcome", async () => {
    expect(await outcomeOf(`throw "plain"`)).toStrictEqual(new Cell.Raised({ name: "Error", message: "plain" }))
    expect(await outcomeOf(`throw 42`)).toStrictEqual(new Cell.Raised({ name: "Error", message: "42" }))
    expect(await outcomeOf(`throw null`)).toStrictEqual(new Cell.Raised({ name: "Error", message: "null" }))
  })

  it("projects a thrown object by its name and message, and defaults each one separately", async () => {
    expect(await outcomeOf(`throw { name: "Custom", message: "detail" }`)).toStrictEqual(
      new Cell.Raised({ name: "Custom", message: "detail" })
    )
    expect(await outcomeOf(`throw { name: "Custom", message: 7 }`)).toStrictEqual(
      new Cell.Raised({ name: "Custom", message: "[object Object]" })
    )
    expect(await outcomeOf(`throw { code: 7 }`)).toStrictEqual(
      new Cell.Raised({ name: "Error", message: "[object Object]" })
    )
  })

  it("separates a value JSON cannot carry from one that is JSON but not a transition", async () => {
    // Both end the frame, and the two rejections say different things: one is
    // about the boundary, the other about the contract.
    for (const expression of [`function () {}`, `Symbol("x")`, `() => 1`]) {
      expect(await outcomeOf(`return ${expression}`), expression).toStrictEqual(
        new Cell.Rejected({
          code: "invalid_transition",
          message: "The cell returned a value that is not JSON-serializable."
        })
      )
    }

    const contract = await outcomeOf(`return { intent: "explode" }`) as Cell.Rejected
    expect(contract.code).toBe("invalid_transition")
    expect(contract.message).toContain("did not return a transition")
  })

  it("reports a cell that escapes the async wrapper and throws a primitive as a compile failure", async () => {
    // The cell text is interpolated into a wrapper, so a cell can close the
    // wrapper and run at the top level of the evaluated program. A primitive
    // thrown there is not an Error object, and the rejection must still read
    // as one sentence the model can act on.
    const outcome = await outcomeOf(`})(), (function () { throw "primitive" })(), (async () => {`)

    expect(outcome).toStrictEqual(
      new Cell.Rejected({ code: "compile_failed", message: "The cell did not compile: primitive" })
    )
  })

  it("stops a cell that escapes the async wrapper and burns the step budget synchronously", async () => {
    // Same escape, spending the budget where no promise can absorb the
    // interrupt. The ceiling still wins, and it is reported as the ceiling it
    // is rather than as a compile failure.
    const outcome = await outcomeOf(
      `})(), (function () { let t = 0; while (true) t = t + 1 })(), (async () => {`,
      { limits: { steps: 20 } }
    )

    expect(outcome).toStrictEqual(
      new Cell.Rejected({
        code: "limit_exceeded",
        message: "This cell exceeded its limit of 20 interpreter steps"
      })
    )
  })
})

describe("QuickJSSandbox calls", () => {
  it("refuses every input shape JSON cannot carry, without opening a boundary", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const call: Sandbox.Handler = (invocation) => {
      observed.push(invocation)
      return Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
    }

    for (
      const expression of [
        `new (class Point { constructor() { this.x = 1 } })()`,
        `(function () { const a = {}; a.self = a; return a })()`,
        `{ go: function () {} }`,
        `{ n: NaN }`,
        `{ u: undefined }`,
        `[Symbol("x")]`
      ]
    ) {
      const outcome = await outcomeOf(
        `try {
           await ctx.call("fs/list", ${expression})
         } catch (error) {
           return { intent: "complete", output: error.name + ": " + error.message }
         }
         return { intent: "complete", output: "accepted" }`,
        { call }
      )
      expect(outcome, expression).toMatchObject({
        _tag: "settled",
        transition: { _tag: "complete", output: "TypeError: ctx.call input must be JSON-serializable" }
      })
    }

    expect(observed).toEqual([])
  })

  it("accepts a null-prototype object as ordinary JSON input", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await outcomeOf(
      `const bare = Object.create(null)
       bare.path = "."
       await ctx.call("fs/list", bare)
       return { intent: "complete", output: "accepted" }`,
      {
        call: (invocation) => {
          observed.push(invocation)
          return Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
        }
      }
    )

    expect(observed.map((invocation) => invocation.input)).toEqual([{ path: "." }])
    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "accepted" } })
  })

  it("names a failure the host reported without a message", async () => {
    const outcome = await outcomeOf(
      `try {
         await ctx.call("fs/list", {})
       } catch (error) {
         return { intent: "complete", output: error.name + "|" + error.message + "|" + JSON.stringify(error.value) }
       }
       return { intent: "complete", output: "unreachable" }`,
      { call: () => Effect.succeed(new Cell.CallResult({ outcome: "failure", value: { why: "denied" } })) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: `FlowCallError|The flow call failed|{"why":"denied"}` }
    })
  })

  it("runs the first call a cell issues only after an unrelated await has resumed it", async () => {
    // The frame starts with nothing queued and nothing settled: the driver has
    // to run the realm's job queue before it can decide the cell is stuck.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await outcomeOf(
      `await null
       const listed = await ctx.call("fs/list", { path: "." })
       return { intent: "complete", output: String(listed.entries.length) }`,
      {
        call: (invocation) => {
          observed.push(invocation)
          return Effect.succeed(new Cell.CallResult({ outcome: "success", value: { entries: ["a", "b"] } }))
        }
      }
    )

    expect(observed).toHaveLength(1)
    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "2" } })
  })
})

describe("QuickJSSandbox interruption", () => {
  it("tears the realm down when the frame is interrupted mid-call, and the next frame still runs", async () => {
    const result = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      let entered = false
      const frame = yield* sandbox.evaluate({
        cell: Cell.source(`await ctx.call("fs/list", {})\nreturn { intent: "complete", output: "unreachable" }`),
        flows,
        call: () =>
          Effect.sync(() => {
            entered = true
          }).pipe(Effect.andThen(Effect.never))
      }).pipe(Effect.forkChild({ startImmediately: true }))

      // Interrupt only once the frame is genuinely suspended in a host call.
      while (!entered) yield* Effect.sleep(5)
      yield* Fiber.interrupt(frame)
      const exit = yield* Fiber.await(frame)

      // The realm the interrupted frame held is gone; a fresh frame proves the
      // shared WebAssembly module was not left in a broken state.
      const after = yield* sandbox.evaluate({
        cell: Cell.source(`return { intent: "complete", output: "after" }`),
        flows,
        call: succeeds
      })
      return { after, entered, exit }
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(result.entered).toBe(true)
    expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
    expect(result.after).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "after" } })
  }, 60_000)
})

describe("QuickJSSandbox memory pressure", () => {
  // Last in the file on purpose: the failure it pins aborts the WebAssembly
  // instance, and nothing after it in this module may depend on that instance.
  it("fails the frame rather than handing the cell a half-materialized reply", async () => {
    const exit = await evaluate(
      `const listed = await ctx.call("fs/list", {})
       return { intent: "complete", output: String(listed.blob.length) }`,
      {
        limits: { memoryBytes: Sandbox.minimumMemoryBytes, steps: Number.MAX_SAFE_INTEGER },
        call: () =>
          Effect.succeed(
            new Cell.CallResult({ outcome: "success", value: { blob: "z".repeat(3 * 1024 * 1024) } })
          )
      }
    )

    expect(Exit.isFailure(exit)).toBe(true)
  }, 60_000)
})
