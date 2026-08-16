/**
 * The sandbox contract, proved identically against both bindings.
 *
 * Every case runs twice: once on the dependency-free restricted binding and
 * once on the QuickJS-WASM binding that a production host actually selects.
 * A contract only one of them honours is not a contract.
 */
import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"

const flows: Readonly<Record<string, Cell.FlowProjection>> = {
  "fs/list": new Cell.FlowProjection({
    name: "fs/list",
    description: "List a directory.",
    capabilities: ["fs:read:**"],
    tier: "sealed",
    placement: Option.none()
  })
}

/** Records every invocation and replies from a scripted table. */
const handler = (
  replies: Readonly<Record<string, Schema.Json>>,
  observed: Array<Sandbox.Invocation>,
  failing: ReadonlySet<string> = new Set()
): Sandbox.Handler =>
(invocation) =>
  Effect.sync(() => {
    observed.push(invocation)
    return failing.has(invocation.flow)
      ? new Cell.CallResult({ outcome: "failure", value: null, message: `${invocation.flow} refused` })
      : new Cell.CallResult({ outcome: "success", value: replies[invocation.flow] ?? null })
  })

const bindings: ReadonlyArray<readonly [string, Layer.Layer<Sandbox.Sandbox>]> = [
  ["restricted", Sandbox.layerRestricted],
  ["quickjs", QuickJSSandbox.layer]
]

const evaluate = (
  binding: Layer.Layer<Sandbox.Sandbox>,
  text: string,
  options: {
    readonly call?: Sandbox.Handler | undefined
    readonly limits?: Sandbox.Limits | undefined
  } = {}
): Promise<Cell.Outcome> =>
  Effect.gen(function*() {
    const sandbox = yield* Sandbox.Sandbox
    return yield* sandbox.evaluate({
      cell: Cell.source(text),
      flows,
      call: options.call ?? handler({}, []),
      limits: options.limits
    })
  }).pipe(Effect.provide(binding), Effect.runPromise)

for (const [name, binding] of bindings) {
  describe(`Sandbox (${name})`, () => {
    it("runs data-dependent calls in issue order without a round trip between them", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `const listed = await ctx.call("fs/list", { path: "." })
         const detail = await ctx.call("fs/list", { path: listed.entries[0] })
         return { intent: "complete", state: { detail }, output: detail.entries.join(",") }`,
        {
          call: handler(
            { "fs/list": { entries: ["alpha", "beta"] } },
            observed
          )
        }
      )

      expect(observed.map((call) => [call.ordinal, call.flow, call.input])).toEqual([
        [0, "fs/list", { path: "." }],
        // The second input is derived from the first result inside the cell.
        [1, "fs/list", { path: "alpha" }]
      ])
      expect(outcome._tag).toBe("settled")
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "alpha,beta"
      })
    })

    it("denies ambient time, randomness, network, and process access", async () => {
      for (const expression of ["Date.now()", "Math.random()", "fetch(\"http://x\")", "process.exit()"]) {
        const outcome = await evaluate(binding, `return { intent: "complete", output: String(${expression}) }`)
        expect(outcome._tag, expression).toBe("raised")
      }
    })

    it("reaches nothing through `this`, which no identifier check can deny", async () => {
      // A `with` block only runs in sloppy mode, and a sloppy function called
      // without a receiver binds `this` to the host realm's global object. That
      // is a path around the scope proxy entirely: `this.process` never looks
      // up an identifier, so denial by identifier cannot see it.
      const outcome = await evaluate(
        binding,
        `return { intent: "complete", output: [typeof this, String(this && this.process)].join("|") }`
      )

      expect(outcome._tag).toBe("settled")
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "object|undefined"
      })
    })

    it("evaluates deterministically: the same cell issues the same calls twice", async () => {
      const first: Array<Sandbox.Invocation> = []
      const second: Array<Sandbox.Invocation> = []
      const text = `const a = await ctx.call("fs/list", { path: "." })
        const b = await ctx.call("fs/list", { path: a.entries.length > 1 ? "many" : "one" })
        return { intent: "complete", output: JSON.stringify(b) }`
      const replies = { "fs/list": { entries: ["a", "b"] } }

      const one = await evaluate(binding, text, { call: handler(replies, first) })
      const two = await evaluate(binding, text, { call: handler(replies, second) })

      expect(first).toEqual(second)
      expect(one).toStrictEqual(two)
    })

    it("makes a failed flow call a catchable exception, not a harness failure", async () => {
      const outcome = await evaluate(
        binding,
        `try {
           await ctx.call("fs/list", {})
           return { intent: "complete", output: "unreachable" }
         } catch (error) {
           return { intent: "complete", output: error.name + ": " + error.message }
         }`,
        { call: handler({}, [], new Set(["fs/list"])) }
      )

      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "FlowCallError: fs/list refused"
      })
    })

    it("settles the active VM bridge before propagating a host failure", async () => {
      const result = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* Effect.result(
          sandbox.evaluate({
            cell: Cell.source(`await ctx.call("fs/list", {})\nreturn null`),
            flows,
            call: () => Effect.fail(new HarnessError({ code: "engine_failed", message: "permission park" }))
          })
        )
      }).pipe(Effect.provide(binding), Effect.runPromise)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "engine_failed", message: "permission park" }
      })
    })

    it("reports a thrown cell as a durable observation", async () => {
      const outcome = await evaluate(binding, `throw new TypeError("bad plan")`)
      expect(outcome).toStrictEqual(new Cell.Raised({ name: "TypeError", message: "bad plan" }))
    })

    it("reports a cell that returns something else as an invalid transition", async () => {
      const outcome = await evaluate(binding, `return "done"`)
      expect(outcome._tag).toBe("rejected")
      expect((outcome as Cell.Rejected).code).toBe("invalid_transition")
    })

    it("reports a cell that does not compile without running anything", async () => {
      const outcome = await evaluate(binding, `return {`)
      expect(outcome._tag).toBe("rejected")
      expect((outcome as Cell.Rejected).code).toBe("compile_failed")
    })

    it("runs erasable TypeScript without changing its runtime meaning", async () => {
      const outcome = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* sandbox.evaluate({
          cell: Cell.source(
            "const x: number = 1\nreturn { intent: \"complete\", output: String(x) }",
            "typescript"
          ),
          flows,
          call: handler({}, [])
        })
      }).pipe(Effect.provide(binding), Effect.runPromise)

      expect(outcome).toStrictEqual(
        new Cell.Settled({
          transition: new Cell.Complete({ state: null, output: "1", reason: undefined })
        })
      )
    })

    it("rejects TypeScript syntax that requires JavaScript emit", async () => {
      const typed = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* sandbox.evaluate({
          cell: Cell.source("enum Direction { Left, Right }\nreturn null", "typescript"),
          flows,
          call: handler({}, [])
        })
      }).pipe(Effect.provide(binding), Effect.runPromise)
      expect(typed._tag).toBe("rejected")
      expect((typed as Cell.Rejected).code).toBe("compile_failed")
    })

    it("enforces a declared call limit as an uncatchable typed outcome", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `await ctx.call("fs/list", {})
         try {
           await ctx.call("fs/list", {})
         } catch (error) {
           return { intent: "complete", output: error.message }
         }
         return { intent: "complete", output: "unreachable" }`,
        { call: handler({}, observed), limits: { calls: 1 } }
      )

      expect(observed).toHaveLength(1)
      expect(outcome).toMatchObject({
        _tag: "rejected",
        code: "limit_exceeded",
        message: "This cell exceeded its limit of 1 flow calls"
      })
    })

    it("exposes the catalog and nothing else on the frozen context", async () => {
      const outcome = await evaluate(
        binding,
        `return { intent: "complete", output: Object.keys(ctx).sort().join(",") + "|" + Object.keys(ctx.flows).join(",") }`
      )
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "call,flows|fs/list"
      })
    })

    it("deep-freezes every catalog descriptor", async () => {
      const outcome = await evaluate(
        binding,
        `return {
           intent: "complete",
           output: String(Object.isFrozen(ctx.flows) && Object.isFrozen(ctx.flows["fs/list"]) && Object.isFrozen(ctx.flows["fs/list"].capabilities))
         }`
      )
      expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "true" })
    })

    it("rejects a non-string flow name before opening a boundary", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `try {
           await ctx.call(42, {})
         } catch (error) {
           return { intent: "complete", output: error.name }
         }`,
        { call: handler({}, observed) }
      )
      expect(observed).toHaveLength(0)
      expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "TypeError" })
    })

    it("rejects non-JSON call input before opening a boundary", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `try {
           await ctx.call("fs/list", { invalid: new Map() })
         } catch (error) {
           return { intent: "complete", output: error.name + ": " + error.message }
         }`,
        { call: handler({}, observed) }
      )
      expect(observed).toHaveLength(0)
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "TypeError: ctx.call input must be JSON-serializable"
      })
    })
  })
}

describe("Sandbox.makeNoop", () => {
  it("reports that no sandbox is configured rather than pretending to run", async () => {
    const outcome = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      return yield* Effect.result(
        sandbox.evaluate({ cell: Cell.source("return null"), flows: {}, call: handler({}, []) })
      )
    }).pipe(Effect.provide(Sandbox.layerNoop()), Effect.runPromise)

    expect(outcome._tag).toBe("Failure")
    expect((outcome as { readonly failure: Sandbox.SandboxError }).failure.code).toBe("unavailable")
  })
})

describe("Sandbox projections", () => {
  it("projects a non-Error throw into a stable outcome", () => {
    expect(Sandbox.raisedOutcome("plain string")).toStrictEqual(
      new Cell.Raised({ name: "Error", message: "plain string" })
    )
    expect(Sandbox.raisedOutcome(new RangeError("out of range"))).toStrictEqual(
      new Cell.Raised({ name: "RangeError", message: "out of range" })
    )
  })

  it("names the exception a cell sees for a failed call", () => {
    const withMessage = Sandbox.failureError(
      new Cell.CallResult({ outcome: "failure", value: null, message: "denied" })
    )
    expect([withMessage.name, withMessage.message]).toEqual(["FlowCallError", "denied"])
    const withoutMessage = Sandbox.failureError(new Cell.CallResult({ outcome: "failure", value: null }))
    expect(withoutMessage.message).toBe("The flow call failed")
  })

  it("defaults every supported safety ceiling and preserves explicit raises", async () => {
    const observed: Array<Sandbox.Limits | undefined> = []
    const sandbox = Sandbox.make({
      capabilities: { calls: true, memoryBytes: true, steps: true, timeMs: true },
      evaluate: (evaluation) =>
        Effect.sync(() => {
          observed.push(evaluation.limits)
          return new Cell.Rejected({ code: "stalled", message: "recorded" })
        })
    })
    const request = {
      cell: Cell.source("return null"),
      flows: {},
      call: handler({}, [])
    }

    await Effect.runPromise(sandbox.evaluate(request))
    await Effect.runPromise(sandbox.evaluate({
      ...request,
      limits: { steps: Sandbox.defaultLimits.steps + 1 }
    }))
    await Effect.runPromise(sandbox.evaluate({
      ...request,
      limits: {
        memoryBytes: Sandbox.defaultLimits.memoryBytes + 1,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs + 1
      }
    }))

    expect(observed).toEqual([
      Sandbox.defaultLimits,
      {
        memoryBytes: Sandbox.defaultLimits.memoryBytes,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs
      },
      {
        memoryBytes: Sandbox.defaultLimits.memoryBytes + 1,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs + 1
      }
    ])
  })

  it("reports which limits a binding can enforce", async () => {
    const capabilities = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      return sandbox.capabilities
    }).pipe(Effect.provide(Sandbox.layerRestricted), Effect.runPromise)
    expect(capabilities).toEqual({ calls: true, memoryBytes: false, steps: false, timeMs: false })

    const quickjs = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      return sandbox.capabilities
    }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.runPromise)
    expect(quickjs).toEqual({ calls: true, memoryBytes: true, steps: true, timeMs: true })
  })
})

describe("Sandbox.layerRestricted", () => {
  it("rejects a call whose flow name is not a string, without queueing it", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      Sandbox.layerRestricted,
      `try {
         await ctx.call(42, {})
       } catch (error) {
         return { intent: "complete", output: error.name }
       }
       return { intent: "complete", output: "unreachable" }`,
      { call: handler({}, observed) }
    )

    expect(observed).toHaveLength(0)
    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "TypeError" })
  })

  it("denies assigning to the cell scope", async () => {
    const outcome = await evaluate(Sandbox.layerRestricted, `leaked = 1\nreturn null`)
    expect(outcome._tag).toBe("raised")
  })

  it("refuses a limit it cannot enforce instead of ignoring it", async () => {
    for (const limits of [{ memoryBytes: 1024 * 1024 }, { steps: 1000 }, { timeMs: 1000 }]) {
      const outcome = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* Effect.result(
          sandbox.evaluate({
            cell: Cell.source("return { intent: \"complete\", output: \"\" }"),
            flows,
            call: handler({}, []),
            limits
          })
        )
      }).pipe(Effect.provide(Sandbox.layerRestricted), Effect.runPromise)

      expect(outcome._tag).toBe("Failure")
      expect((outcome as { readonly failure: Sandbox.SandboxError }).failure.code).toBe("unsupported")
    }
  })
})

describe("QuickJSSandbox", () => {
  it("enforces a declared memory limit", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `const held = []
       for (let index = 0; index < 100000; index++) held.push({ index: index, pad: "x".repeat(64) })
       return { intent: "complete", output: String(held.length) }`,
      { limits: { memoryBytes: 1024 * 1024 } }
    )
    expect(outcome._tag).not.toBe("settled")
  })

  it("stops a cell that awaits something the realm can never settle", async () => {
    const outcome = await evaluate(QuickJSSandbox.layer, `await new Promise(() => {})\nreturn null`)
    expect(outcome._tag).toBe("rejected")
    expect((outcome as Cell.Rejected).code).toBe("stalled")
  })

  it("enforces a declared step limit", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `let total = 0
       for (let index = 0; index < 100000000; index++) total += index
       return { intent: "complete", output: String(total) }`,
      { limits: { steps: 100 } }
    )
    expect(outcome).toMatchObject({
      _tag: "rejected",
      code: "limit_exceeded",
      message: "This cell exceeded its limit of 100 interpreter steps"
    })
  })

  it("enforces default ceilings when the caller omits limits", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `let total = 0
       while (true) total += 1`
    )

    expect(outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
  })

  it("enforces a wall-clock limit while a flow call is stalled", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `await ctx.call("fs/list", {})
       return { intent: "complete", output: "unreachable" }`,
      {
        call: () => Effect.never,
        limits: { timeMs: 10, steps: Number.MAX_SAFE_INTEGER }
      }
    )

    expect(outcome).toMatchObject({
      _tag: "rejected",
      code: "limit_exceeded",
      message: "This cell exceeded its wall-clock limit of 10 milliseconds"
    })
  })
})
