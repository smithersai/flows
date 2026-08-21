/**
 * The sandbox contract, proved identically against both bindings.
 *
 * Every case runs twice: once on the dependency-free restricted binding and
 * once on the QuickJS-WASM binding that a production host actually selects.
 * A contract only one of them honours is not a contract.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import { rejectedCell, rejectedCellNames } from "./fixtures/rejectedCells.ts"

const listInputDocument = JSON.parse(
  JSON.stringify(Schema.toJsonSchemaDocument(Schema.Struct({ path: Schema.String })))
) as Schema.Json

const flows: Readonly<Record<string, Cell.FlowProjection>> = {
  "fs/list": new Cell.FlowProjection({
    name: "fs/list",
    description: "List a directory.",
    capabilities: ["fs:read:**"],
    tier: "sealed",
    placement: Option.none(),
    input: Option.some(listInputDocument)
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

const bindings: ReadonlyArray<readonly [string, Layer.Layer<Sandbox.Sandbox, unknown>]> = [
  ["restricted", Sandbox.layerRestricted],
  ["quickjs", QuickJSSandbox.layer]
]

const evaluate = (
  binding: Layer.Layer<Sandbox.Sandbox, unknown>,
  text: string,
  options: {
    readonly call?: Sandbox.Handler | undefined
    readonly limits?: Sandbox.Limits | undefined
    readonly state?: Schema.Json | undefined
  } = {}
): Promise<Cell.Outcome> =>
  Effect.gen(function*() {
    const sandbox = yield* Sandbox.Sandbox
    return yield* sandbox.evaluate({
      cell: Cell.source(text),
      flows,
      call: options.call ?? handler({}, []),
      state: options.state,
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

    it("returns mutable object properties from flow calls", async () => {
      const outcome = await evaluate(
        binding,
        `const result = await ctx.call("fs/list", {})
         result.entry.name = "renamed"
         return { intent: "complete", output: result.entry.name }`,
        { call: handler({ "fs/list": { entry: { name: "original" } } }, []) }
      )

      expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "renamed" })
    })

    it("returns mutable arrays from flow calls", async () => {
      const outcome = await evaluate(
        binding,
        `const result = await ctx.call("fs/list", {})
         result.entries.push("beta")
         result.entries[0] = "renamed"
         return { intent: "complete", output: result.entries.join(",") }`,
        { call: handler({ "fs/list": { entries: ["alpha"] } }, []) }
      )

      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "renamed,beta"
      })
    })

    it("uses ordinary JSON data-property descriptors for flow results", async () => {
      const outcome = await evaluate(
        binding,
        `const result = await ctx.call("fs/list", {})
         const objectDescriptor = Object.getOwnPropertyDescriptor(result, "entry")
         const indexDescriptor = Object.getOwnPropertyDescriptor(result.entries, "0")
         return {
           intent: "complete",
           output: [
             objectDescriptor.writable,
             objectDescriptor.enumerable,
             objectDescriptor.configurable,
             indexDescriptor.writable,
             indexDescriptor.enumerable,
             indexDescriptor.configurable
           ].join(",")
         }`,
        { call: handler({ "fs/list": { entry: "value", entries: ["alpha"] } }, []) }
      )

      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "true,true,true,true,true,true"
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

    it("teaches ctx.call to a cell that imports, and runs one that only quotes an import", async () => {
      const imported = await evaluate(binding, `import { readFile } from "node:fs"\nreturn null`)
      expect(imported._tag).toBe("rejected")
      expect((imported as Cell.Rejected).code).toBe("imports_forbidden")
      expect((imported as Cell.Rejected).message).toContain("ctx.call")

      // The same word, inside the string a benchmark cell actually passed.
      const quoted = await evaluate(
        binding,
        `const command = "python - <<'PY'\\nfrom pathlib import Path\\nprint(Path('.'))\\nPY"
         return { intent: "complete", output: command }`
      )
      expect(quoted._tag).toBe("settled")
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

    it("settles a stalled flow call at its own budget as a catchable failure", async () => {
      // The defect this bounds: a broad `grep` that never settled held its
      // frame for the whole 900,000 ms evaluation ceiling and was reported to
      // the model as nothing at all. A per-call budget answers the call
      // instead, inside the frame the cell is still running.
      let entered = false
      const outcome = await evaluate(
        binding,
        `try {
           await ctx.call("fs/list", {})
           return { intent: "complete", output: "unreachable" }
         } catch (error) {
           return {
             intent: "complete",
             output: JSON.stringify({ name: error.name, message: error.message, value: error.value })
           }
         }`,
        {
          call: () =>
            Effect.sync(() => {
              entered = true
            }).pipe(Effect.andThen(Effect.never)),
          limits: { callMs: 50 }
        }
      )

      expect(entered).toBe(true)
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: JSON.stringify({
          name: Sandbox.callTimeoutErrorName,
          message:
            "Flow fs/list timed out after 0.05 seconds. Narrow the call — a smaller root, a tighter pattern, a shorter command — and issue it again.",
          value: { _tag: Sandbox.callTimeoutTag, flow: "fs/list", budgetMs: 50 }
        })
      })
    })

    it("leaves the frame alive after a timed-out call, so a narrower call still runs", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `try {
           await ctx.call("fs/list", { path: "." })
         } catch {
           const narrowed = await ctx.call("fs/list", { path: "django" })
           return { intent: "complete", output: narrowed.entries.join(",") }
         }
         return { intent: "complete", output: "unreachable" }`,
        {
          call: (invocation) => {
            observed.push(invocation)
            return invocation.ordinal === 0
              ? Effect.never
              : Effect.succeed(new Cell.CallResult({ outcome: "success", value: { entries: ["sites.py"] } }))
          },
          limits: { callMs: 50 }
        }
      )

      expect(observed.map((call) => call.input)).toEqual([{ path: "." }, { path: "django" }])
      expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "sites.py" })
    })

    it("does not charge a settled call against the next call's budget", async () => {
      const outcome = await evaluate(
        binding,
        `await ctx.call("fs/list", { path: "one" })
         await ctx.call("fs/list", { path: "two" })
         return { intent: "complete", output: "both" }`,
        {
          call: () =>
            Effect.sleep(120).pipe(
              Effect.as(new Cell.CallResult({ outcome: "success", value: null }))
            ),
          limits: { callMs: 300, timeMs: undefined }
        }
      )

      expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "both" })
    })

    it("exposes the catalog, the state, and nothing else on the frozen context", async () => {
      const outcome = await evaluate(
        binding,
        `return { intent: "complete", output: Object.keys(ctx).sort().join(",") + "|" + Object.keys(ctx.flows).join(",") }`
      )
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "call,flows,state|fs/list"
      })
    })

    it("hands the previous frame's state to the cell as a frozen ctx.state", async () => {
      const outcome = await evaluate(
        binding,
        `const before = ctx.state.plan[0]
         try { ctx.state.plan.push("mutated") } catch (error) {}
         return { intent: "complete", state: {}, output: before + ":" + ctx.state.plan.length }`,
        { state: { plan: ["read calc.py"] } }
      )
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "read calc.py:1"
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

    it("reads an omitted call input as the same null an explicit one carries", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `const omitted = await ctx.call("fs/list")
         const explicit = await ctx.call("fs/list", null)
         return { intent: "complete", output: JSON.stringify([omitted, explicit]) }`,
        { call: handler({}, observed) }
      )

      expect(observed.map((call) => [call.ordinal, call.input])).toEqual([[0, null], [1, null]])
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "[null,null]"
      })
    })

    it("answers a call at a zero per-call budget without waiting for the host", async () => {
      // Zero is the boundary the message renderer has to survive as well: a
      // whole number of seconds must not read as "0.000".
      const outcome = await evaluate(
        binding,
        `try {
           await ctx.call("fs/list", {})
         } catch (error) {
           return { intent: "complete", output: error.name + ": " + error.message }
         }
         return { intent: "complete", output: "unreachable" }`,
        { call: () => Effect.never, limits: { callMs: 0 } }
      )

      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: `${Sandbox.callTimeoutErrorName}: Flow fs/list timed out after 0 seconds. `
          + "Narrow the call — a smaller root, a tighter pattern, a shorter command — and issue it again."
      })
    })

    it("admits exactly as many calls as the budget allows", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `await ctx.call("fs/list", {})
         return { intent: "complete", output: "spent the budget exactly" }`,
        { call: handler({}, observed), limits: { calls: 1 } }
      )

      expect(observed).toHaveLength(1)
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "spent the budget exactly"
      })
    })

    it("refuses the very first call when the budget is zero", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `await ctx.call("fs/list", {})
         return { intent: "complete", output: "unreachable" }`,
        { call: handler({}, observed), limits: { calls: 0 } }
      )

      expect(observed).toEqual([])
      expect(outcome).toStrictEqual(
        new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 0 flow calls" })
      )
    })

    it("settles a cell that makes no call at all under a zero call budget", async () => {
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `return { intent: "complete", output: String(Object.keys(ctx.flows).length) }`,
        { call: handler({}, observed), limits: { calls: 0 } }
      )

      expect(observed).toEqual([])
      expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "1" })
    })

    it("settles the calls still queued behind the one that spent the budget", async () => {
      // Three calls are issued before any of them settles, so when the second
      // one meets the ceiling a third is still queued behind it. A queued call
      // that is never answered leaves a live promise behind a frame that is
      // already gone.
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `await Promise.all([
           ctx.call("fs/list", { a: 1 }),
           ctx.call("fs/list", { b: 2 }),
           ctx.call("fs/list", { c: 3 })
         ])
         return { intent: "complete", output: "unreachable" }`,
        { call: handler({}, observed), limits: { calls: 1 } }
      )

      expect(observed.map((call) => call.input)).toEqual([{ a: 1 }])
      expect(outcome).toStrictEqual(
        new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 1 flow calls" })
      )
    })

    it("settles concurrent calls one at a time, in the order the cell issued them", async () => {
      // Ordinals are the replay anchor, so calls that are issued together must
      // still be numbered and answered in issue order rather than interleaved.
      const observed: Array<Sandbox.Invocation> = []
      const outcome = await evaluate(
        binding,
        `const results = await Promise.all([
           ctx.call("fs/list", { path: "a" }),
           ctx.call("fs/list", { path: "b" }),
           ctx.call("fs/list", { path: "a" })
         ])
         return { intent: "complete", output: results.join(",") }`,
        {
          call: (invocation) => {
            observed.push(invocation)
            return Effect.succeed(
              new Cell.CallResult({ outcome: "success", value: `${invocation.ordinal}:${observed.length}` })
            )
          }
        }
      )

      expect(observed.map((call) => [call.ordinal, call.input])).toEqual([
        [0, { path: "a" }],
        [1, { path: "b" }],
        // The same input twice is two calls with two ordinals, not one shared
        // answer: identity is positional, not content-addressed.
        [2, { path: "a" }]
      ])
      expect((outcome as Cell.Settled).transition).toMatchObject({
        _tag: "complete",
        output: "0:1,1:2,2:3"
      })
    })

    it("reports a rejected promise the cell returns as the failure it carries", async () => {
      expect(await evaluate(binding, `return Promise.reject(new RangeError("nope"))`)).toStrictEqual(
        new Cell.Raised({ name: "RangeError", message: "nope" })
      )
    })

    it("lets a host handler that dies take the frame down instead of answering the cell", async () => {
      const exit = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* Effect.exit(sandbox.evaluate({
          cell: Cell.source(
            `try {
               await ctx.call("fs/list", {})
             } catch (error) {
               return { intent: "complete", output: "the cell caught a host defect" }
             }
             return { intent: "complete", output: "unreachable" }`
          ),
          flows,
          call: () =>
            Effect.sync(() => {
              throw new Error("the host blew up")
            })
        }))
      }).pipe(Effect.provide(binding), Effect.runPromise)

      // A defect in the host is not data the cell may recover from: the frame
      // ends, and no outcome is produced for the journal to record as an answer.
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Cause.pretty((exit as Exit.Failure<never, never>).cause)).toContain("the host blew up")
    })

    it("rejects every returned shape that is not a transition", async () => {
      for (
        const expression of [
          "",
          " 42",
          " null",
          " \"done\"",
          " []",
          " { intent: \"explode\" }",
          " { intent: \"complete\" }",
          " [{ intent: \"complete\", output: \"x\" }]"
        ]
      ) {
        const outcome = await evaluate(binding, `return${expression}`)
        expect(outcome._tag, expression).toBe("rejected")
        expect((outcome as Cell.Rejected).code, expression).toBe("invalid_transition")
      }
    })

    it("carries a half-megabyte output out of the cell", async () => {
      const outcome = await evaluate(binding, `return { intent: "complete", output: "q".repeat(512 * 1024) }`)
      const settled = outcome as Cell.Settled
      expect(settled.transition._tag).toBe("complete")
      expect((settled.transition as Cell.Complete).output.length).toBe(512 * 1024)
    }, 60_000)

    it("surfaces an interruption mid-call as an interrupted exit, never as an outcome", async () => {
      const result = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        const entered = yield* Deferred.make<void>()
        const frame = yield* sandbox.evaluate({
          cell: Cell.source(`await ctx.call("fs/list", {})\nreturn { intent: "complete", output: "unreachable" }`),
          flows,
          call: () => Deferred.succeed(entered, void 0).pipe(Effect.andThen(Effect.never))
        }).pipe(Effect.forkChild({ startImmediately: true }))

        // Interrupt only once the frame is genuinely suspended in a host call.
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(frame)
        return { exit: yield* Fiber.await(frame) }
      }).pipe(Effect.provide(binding), Effect.scoped, Effect.runPromise)

      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
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
    const timedOut = Sandbox.failureError(
      new Cell.CallResult({
        outcome: "failure",
        value: { _tag: Sandbox.callTimeoutTag, flow: "grep", budgetMs: 120_000 }
      })
    ) as Error & { readonly value: unknown }
    expect([timedOut.name, timedOut.value]).toEqual([
      Sandbox.callTimeoutErrorName,
      { _tag: Sandbox.callTimeoutTag, flow: "grep", budgetMs: 120_000 }
    ])
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
        calls: Sandbox.defaultLimits.calls,
        memoryBytes: Sandbox.defaultLimits.memoryBytes,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs,
        totalMs: Sandbox.defaultLimits.totalMs,
        callMs: Sandbox.defaultLimits.callMs
      },
      {
        calls: Sandbox.defaultLimits.calls,
        memoryBytes: Sandbox.defaultLimits.memoryBytes + 1,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs + 1,
        totalMs: Sandbox.defaultLimits.totalMs,
        callMs: Sandbox.defaultLimits.callMs
      }
    ])
  })

  it("rejects invalid numeric ceilings before entering a binding", async () => {
    let evaluations = 0
    const sandbox = Sandbox.make({
      capabilities: { calls: true, memoryBytes: true, steps: true, timeMs: true },
      evaluate: () => {
        evaluations = evaluations + 1
        return Effect.succeed(new Cell.Rejected({ code: "stalled", message: "entered" }))
      }
    })
    const request = {
      cell: Cell.source("return null"),
      flows: {},
      call: handler({}, [])
    }

    for (
      const limits of [
        { timeMs: Number.POSITIVE_INFINITY },
        { timeMs: Number.NaN },
        { totalMs: Number.POSITIVE_INFINITY },
        { totalMs: Number.NaN },
        { callMs: -1 },
        { callMs: Number.NaN },
        { steps: Number.POSITIVE_INFINITY },
        { steps: Number.NaN },
        { memoryBytes: 0 },
        { memoryBytes: 1 }
      ]
    ) {
      const result = await Effect.runPromise(Effect.result(sandbox.evaluate({ ...request, limits })))
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "unsupported" }
      })
    }

    expect(evaluations).toBe(0)
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
    for (
      const limits of [{ memoryBytes: 1024 * 1024 }, { steps: 1000 }, { timeMs: 1000 }, { totalMs: 1000 }]
    ) {
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

  it("never reaches the host for a call issued after the budget was already spent", async () => {
    // The frame is already rejected by the time the third call is issued, so
    // its only observable trace is whether the host saw it. It must not.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      Sandbox.layerRestricted,
      `await ctx.call("fs/list", {})
       try {
         await ctx.call("fs/list", {})
       } catch (overBudget) {
         try {
           await ctx.call("fs/list", {})
         } catch (afterAbort) {
           return { intent: "complete", output: afterAbort.message }
         }
       }
       return { intent: "complete", output: "unreachable" }`,
      { call: handler({}, observed), limits: { calls: 1 } }
    )

    expect(observed).toHaveLength(1)
    expect(outcome).toStrictEqual(
      new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 1 flow calls" })
    )
  })

  it("keeps a cell that escapes its function wrapper inside the outcome contract", async () => {
    // This binding is explicitly not an isolation boundary: the cell text is
    // interpolated into a wrapper built with `new Function`, so a cell can
    // close the wrapper and run in the host realm. What it must not do is take
    // the harness down with it. The escape below reads a symbol-keyed property
    // off the scope object — which answers `undefined` rather than a host
    // binding — and then throws where no promise exists to catch it.
    const outcome = await evaluate(
      Sandbox.layerRestricted,
      `} }).call(__this) + (function () {
         throw new Error("escaped:" + String(__scope[Symbol.iterator]))
       })();
       (async function () { with (__scope) {`
    )

    expect(outcome).toStrictEqual(new Cell.Raised({ name: "Error", message: "escaped:undefined" }))
  })
})

describe("Sandbox.compile", () => {
  it("hands a JavaScript cell through untouched", () => {
    expect(Sandbox.compile(Cell.source("return null", "javascript"))).toBe("return null")
  })

  it("erases type-only syntax from a TypeScript cell", () => {
    const compiled = Sandbox.compile(Cell.source("const x: number = 1\nreturn x", "typescript"))
    expect(compiled).toContain("const x = 1")
    expect(compiled).not.toContain("number")
    // The emit carries a "use strict" line. It is not a directive prologue
    // where the restricted binding places it, so the `with` wrapper that
    // binding relies on still runs — which the TypeScript cases above prove.
    expect(compiled).toContain("\"use strict\"")
  })

  it("names the construct that needs JavaScript emit rather than emitting it", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["enum Direction { Left, Right }\nreturn null", "enum declarations"],
      // The `export` inside the namespace is not ESM, and the module check
      // steps over a namespace body so it cannot be read as ESM either.
      ["namespace Shapes { export const sides = 3 }\nreturn null", "namespace/module declarations"],
      ["declare module \"node:fs\" {}\nreturn null", "namespace/module declarations"],
      ["class A { constructor(public a: number) {} }\nreturn null", "parameter properties"],
      ["class A { constructor(private a: number) {} }\nreturn null", "parameter properties"],
      ["class A { constructor(protected a: number) {} }\nreturn null", "parameter properties"],
      ["class A { constructor(readonly a: number) {} }\nreturn null", "parameter properties"],
      // `override` is the last modifier the check tests, so it is the one that
      // proves the whole list is consulted and not just its first entries.
      ["class A { constructor(override a: number) {} }\nreturn null", "parameter properties"]
    ]

    for (const [text, forbidden] of cases) {
      expect(Sandbox.compile(Cell.source(text, "typescript")), text).toStrictEqual(
        new Cell.Rejected({
          code: "compile_failed",
          message: `The TypeScript cell uses ${forbidden}, which are not erasable syntax.`
        })
      )
    }
  })

  it("keeps a class whose constructor parameters carry no modifier at all", () => {
    const compiled = Sandbox.compile(
      Cell.source("class Point { constructor(x: number) { this.x = x } }\nreturn null", "typescript")
    )
    expect(typeof compiled).toBe("string")
    expect(compiled).toContain("constructor(x)")
  })

  it("reports a TypeScript cell that does not parse as a correctable rejection", () => {
    expect(Sandbox.compile(Cell.source("return {", "typescript"))).toStrictEqual(
      new Cell.Rejected({
        code: "compile_failed",
        message: "The TypeScript cell did not compile: '}' expected."
      })
    )
  })

  it("refuses module syntax and says which binding to use instead", () => {
    const cases: ReadonlyArray<readonly [string, Cell.Language, string]> = [
      ["import { readFile } from \"node:fs\"\nreturn null", "javascript", "import"],
      ["import \"node:fs\"\nimport \"node:path\"\nreturn null", "javascript", "import"],
      ["const m = await import(\"node:fs\")\nreturn null", "javascript", "import"],
      ["return import.meta.url", "javascript", "import"],
      ["const fs = require(\"node:fs\")\nreturn null", "javascript", "require"],
      ["export const x = 1\nreturn null", "javascript", "export"],
      ["const x = 1\nexport { x }\nreturn null", "javascript", "export"],
      ["export default 1", "javascript", "export"],
      ["import fs = require(\"node:fs\")\nreturn null", "typescript", "import"],
      ["export = 1", "typescript", "export"]
    ]

    for (const [text, language, syntax] of cases) {
      expect(Sandbox.compile(Cell.source(text, language)), text).toStrictEqual(
        new Cell.Rejected({
          code: "imports_forbidden",
          message: `A cell may not ${syntax} anything: it runs in a realm with no module loader. ` +
            "Use ctx.call for every effect and ctx.flows for the catalog it may call; " +
            "they are the only bindings a cell has."
        })
      )
    }
  })

  it("keeps the JavaScript that only looks like module syntax", () => {
    const cases: ReadonlyArray<string> = [
      // The identifier prefix, the property name, and the string: the three
      // ways a regexp over the source read a cell as importing.
      "const important = ctx.flows\nreturn important.export",
      "return ctx.call(\"bash\", { command: \"python -c 'from pathlib import Path'\" })",
      "return ctx.call(\"grep\", { pattern: \"from _pytest import\" })",
      // A modifier that is not `export`, and a meta-property that is not
      // `import.meta`.
      "async function work() { return new.target }\nreturn work()"
    ]

    for (const text of cases) {
      expect(Sandbox.compile(Cell.source(text)), text).toBe(text)
    }
  })

  for (const name of rejectedCellNames) {
    it(`compiles the wave-5 cell ${name} that the text match rejected`, () => {
      const extracted = Cell.extract(rejectedCell(name))
      expect(extracted._tag).toBe("Success")
      expect(typeof Sandbox.compile((extracted as { readonly success: Cell.Extracted }).success.source)).toBe("string")
    })
  }
})

describe("Sandbox.layer", () => {
  it("provides an implementation that still validates and defaults its ceilings", async () => {
    const observed: Array<Sandbox.Limits | undefined> = []
    const layer = Sandbox.layer({
      capabilities: { calls: true, memoryBytes: false, steps: false, timeMs: true },
      evaluate: (evaluation) =>
        Effect.sync(() => {
          observed.push(evaluation.limits)
          return new Cell.Rejected({ code: "stalled", message: "recorded" })
        })
    })
    const request = { cell: Cell.source("return null"), flows: {}, call: handler({}, []) }

    const [defaulted, refused] = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      return [
        yield* sandbox.evaluate(request),
        yield* Effect.result(sandbox.evaluate({ ...request, limits: { calls: -1 } }))
      ] as const
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // The ceilings the declared capabilities can enforce are filled in, and the
    // one they cannot (`memoryBytes`) is left absent rather than invented.
    expect(observed).toEqual([{
      calls: Sandbox.defaultLimits.calls,
      steps: undefined,
      timeMs: Sandbox.defaultLimits.timeMs,
      totalMs: Sandbox.defaultLimits.totalMs,
      callMs: Sandbox.defaultLimits.callMs
    }])
    expect(defaulted).toStrictEqual(new Cell.Rejected({ code: "stalled", message: "recorded" }))
    expect(refused).toMatchObject({ _tag: "Failure", failure: { code: "unsupported" } })
  })
})

describe("Sandbox.latch", () => {
  it("holds a waiting fiber until it is woken, and drops a wake nobody is waiting on", async () => {
    const gate = Sandbox.latch()
    const order: Array<string> = []

    // Nothing is waiting yet, so this wake has nobody to resume and nothing to
    // remember: the fiber that arrives afterwards still has to be woken.
    gate.wake()

    const woken = await Effect.gen(function*() {
      const waiter = yield* gate.wait.pipe(
        Effect.andThen(Effect.sync(() => order.push("woken"))),
        Effect.as("woken"),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      order.push("still waiting")
      gate.wake()
      return yield* Fiber.join(waiter)
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(woken).toBe("woken")
    expect(order).toEqual(["still waiting", "woken"])
  })
})

describe("QuickJSSandbox", () => {
  it("exposes a flow's input schema document in the cell realm", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `return { intent: "complete", output: JSON.stringify(ctx.flows["fs/list"].input) }`
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: JSON.stringify(listInputDocument) }
    })
  })

  it("preserves a JSON __proto__ key as an own data property", async () => {
    const payload = JSON.parse("{\"__proto__\":{\"unexpected\":\"prototype\"}}") as Schema.Json
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `const result = await ctx.call("fs/list", {})
       return {
         intent: "complete",
         output: [
           Object.keys(result).join(","),
           Object.hasOwn(result, "__proto__"),
           Object.prototype.hasOwnProperty.call(result, "__proto__"),
           Object.getPrototypeOf(result) === Object.prototype ? "" : "yes",
           Object.getOwnPropertyDescriptor(result, "__proto__").writable
         ].join("|")
       }`,
      { call: handler({ "fs/list": payload }, []) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: "__proto__|true|true||true" }
    })
  })

  it("does not invoke hostile Object.prototype setters while materializing flow results", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `let captured = "missed"
       Object.defineProperty(Object.prototype, "entry", {
         configurable: true,
         set: function () { captured = "captured" }
       })
       const result = await ctx.call("fs/list", {})
       return {
         intent: "complete",
         output: [Object.hasOwn(result, "entry"), String(result.entry), captured].join("|")
       }`,
      { call: handler({ "fs/list": { entry: "preserved" } }, []) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: "true|preserved|missed" }
    })
  })

  it("does not invoke hostile Array.prototype setters while materializing flow results", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `let captured = "missed"
       Object.defineProperty(Array.prototype, "0", {
         configurable: true,
         set: function (value) { if (value === "preserved") captured = "captured" }
       })
       const result = await ctx.call("fs/list", {})
       return {
         intent: "complete",
         output: [Object.hasOwn(result.entries, "0"), String(result.entries[0]), captured].join("|")
       }`,
      { call: handler({ "fs/list": { entries: ["preserved"] } }, []) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: "true|preserved|missed" }
    })
  })

  it("carries a 2 MB flow result across the WebAssembly boundary", async () => {
    const payload = `${"x".repeat(2 * 1024 * 1024)}🗼`
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `const text = await ctx.call("fs/list", { path: "big" })
       return { intent: "complete", output: text.length + ":" + text.slice(-2) }`,
      { call: handler({ "fs/list": payload }, []) }
    )

    expect(outcome._tag).toBe("settled")
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: `${payload.length}:🗼`
    })
  }, 60_000)

  it("rejects pathological memory limits before QuickJS initialization", async () => {
    for (const memoryBytes of [0, 1]) {
      const result = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* Effect.result(
          sandbox.evaluate({
            cell: Cell.source("return null"),
            flows,
            call: handler({}, []),
            limits: { memoryBytes }
          })
        )
      }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.runPromise)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "unsupported",
          message: `The memoryBytes limit must be a safe integer of at least ${Sandbox.minimumMemoryBytes} bytes`
        }
      })
    }
  })

  it("enforces a declared memory limit", async () => {
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `const held = []
       for (let index = 0; index < 100000; index++) held.push({ index: index, pad: "x".repeat(64) })
       return { intent: "complete", output: String(held.length) }`,
      { limits: { memoryBytes: Sandbox.minimumMemoryBytes } }
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

  it("bounds a stalled flow call with the whole-evaluation ceiling, not the compute clock", async () => {
    let handlerEntered = false
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `await ctx.call("fs/list", {})
       return { intent: "complete", output: "unreachable" }`,
      {
        call: () =>
          Effect.sync(() => {
            handlerEntered = true
          }).pipe(Effect.andThen(Effect.never)),
        limits: { timeMs: 60_000, totalMs: 250, steps: Number.MAX_SAFE_INTEGER }
      }
    )

    expect(handlerEntered).toBe(true)
    expect(outcome).toMatchObject({
      _tag: "rejected",
      code: "limit_exceeded",
      message: "This cell exceeded its wall-clock limit of 250 milliseconds"
    })
  })

  it("refunds a settled flow call's duration to the compute clock", async () => {
    // The call takes longer than the whole compute budget. Charging its
    // duration to the cell rejected every frame that awaited a real test run;
    // the settled call must instead resume the cell with its budget intact.
    const outcome = await evaluate(
      QuickJSSandbox.layer,
      `const listed = await ctx.call("fs/list", {})
       return { intent: "complete", state: {}, output: String(listed.ok) }`,
      {
        call: () =>
          Effect.sleep(400).pipe(
            Effect.as({ outcome: "success", value: { ok: true } } as const)
          ),
        limits: { timeMs: 250, totalMs: 60_000, steps: Number.MAX_SAFE_INTEGER }
      }
    )

    expect(outcome).toMatchObject({ _tag: "settled" })
  })
})
