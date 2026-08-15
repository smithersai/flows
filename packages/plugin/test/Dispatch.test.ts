import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { ErrorClass, FlowsPlugin } from "../src/index.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

const dispatcherFor = async (plugins: ReadonlyArray<FlowsPlugin>) => Plugins.make(await run(Resolve.resolve(plugins)))

describe("Plugins layers", () => {
  it("provides a dispatcher over a resolved list, and a plugin-free one", async () => {
    const seen: Array<string> = []
    const resolved = await run(Resolve.resolve([
      { name: "a", hooks: { runStart: () => Effect.sync(() => void seen.push("a")) } }
    ]))
    const program = Plugins.Plugins.pipe(
      Effect.flatMap((dispatcher) => dispatcher.parallel("runStart", { runId: "r" }))
    )
    expect(await run(program.pipe(Effect.provide(Plugins.layer(resolved))))).toEqual([])
    expect(seen).toEqual(["a"])
    expect(await run(program.pipe(Effect.provide(Plugins.layerNoop)))).toEqual([])
    expect(seen).toEqual(["a"])
  })
})

describe("sequential dispatch", () => {
  it("runs every handler in resolved order, one at a time, collecting results", async () => {
    const trace: Array<string> = []
    const verdict = (name: string, answer: "fail" | "tolerate"): FlowsPlugin => ({
      name,
      hooks: {
        cacheInconsistency: () =>
          Effect.sync(() => {
            trace.push(`enter:${name}`)
            return answer
          }).pipe(Effect.tap(() => Effect.sync(() => trace.push(`exit:${name}`))))
      }
    })
    const dispatcher = await dispatcherFor([verdict("a", "tolerate"), verdict("b", "fail"), verdict("c", "tolerate")])
    const results = await run(
      dispatcher.sequential("cacheInconsistency", { key: "k", existing: {}, attempted: {} })
    )
    expect(results).toEqual(["tolerate", "fail", "tolerate"])
    // every handler observes the event, and none interleaves with another
    expect(trace).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"])
    expect(results.includes("fail")).toBe(true)
  })

  it("fails the caller with hook_failed and stops at the failing handler", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      { name: "ok", hooks: { checkpoint: () => Effect.sync(() => void seen.push("ok")) } },
      { name: "bad", hooks: { checkpoint: () => Effect.die(new Error("boom")) } },
      { name: "never", hooks: { checkpoint: () => Effect.sync(() => void seen.push("never")) } }
    ])
    const error = await run(
      dispatcher.sequential("checkpoint", { runId: "r", stepKey: "s", seq: 1 }).pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.plugin).toBe("bad")
    expect(error.hook).toBe("checkpoint")
    expect(seen).toEqual(["ok"])
  })

  it("wraps a synchronous throw inside a handler", async () => {
    const dispatcher = await dispatcherFor([
      {
        name: "thrower",
        hooks: {
          checkpoint: (() => {
            throw new Error("sync boom")
          }) as never
        }
      }
    ])
    const error = await run(
      dispatcher.sequential("checkpoint", { runId: "r", stepKey: "s", seq: 1 }).pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.plugin).toBe("thrower")
  })

  it("propagates a typed veto from runControl", async () => {
    const dispatcher = await dispatcherFor([
      { name: "veto", hooks: { runControl: () => Effect.fail({ _tag: "ControlRejected", reason: "nope" }) } }
    ])
    const error = await run(
      dispatcher.sequential("runControl", { verb: "cancel", actor: "will", runId: "r" }).pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
  })
})

describe("parallel dispatch", () => {
  it("runs every observer and isolates a failing one", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      { name: "a", hooks: { stepStart: () => Effect.sync(() => void seen.push("a")) } },
      { name: "b", hooks: { stepStart: () => Effect.fail("observer boom") } },
      { name: "c", hooks: { stepStart: () => Effect.sync(() => void seen.push("c")) } }
    ])
    const errors = await run(dispatcher.parallel("stepStart", { runId: "r", stepKey: "s" }))
    expect(seen.sort()).toEqual(["a", "c"])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe("hook_failed")
    expect(errors[0]?.plugin).toBe("b")
  })

  it("surfaces every failure and never fails the caller", async () => {
    const dispatcher = await dispatcherFor([
      { name: "a", hooks: { journalEvent: () => Effect.fail("x") } },
      { name: "b", hooks: { journalEvent: () => Effect.die("y") } }
    ])
    const errors = await run(dispatcher.parallel("journalEvent", { runId: "r", type: "t" }))
    expect(errors.map((error) => error.plugin).sort()).toEqual(["a", "b"])
  })
})

describe("first dispatch", () => {
  const classifier = (name: string, answer: Option.Option<ErrorClass>, seen: Array<string>): FlowsPlugin => ({
    name,
    hooks: {
      classifyError: () =>
        Effect.sync(() => {
          seen.push(name)
          return answer
        })
    }
  })

  it("stops at the first Option.some", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      classifier("a", Option.none(), seen),
      classifier("b", Option.some("permanent"), seen),
      classifier("c", Option.some("transient"), seen)
    ])
    const result = await run(dispatcher.first("classifyError", new Error("x"), { runId: "r", stepKey: "s" }))
    expect(result).toEqual(Option.some("permanent"))
    expect(seen).toEqual(["a", "b"])
  })

  it("returns none so the caller can apply its core default", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([classifier("a", Option.none(), seen)])
    const result = await run(dispatcher.first("classifyError", new Error("x"), { runId: "r", stepKey: "s" }))
    const classification = Option.getOrElse(result, (): ErrorClass => "transient")
    expect(classification).toBe("transient")
    expect(seen).toEqual(["a"])
  })

  it("respects per-hook order when choosing the winner", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      classifier("normal", Option.some("transient"), seen),
      {
        name: "override",
        hooks: {
          classifyError: {
            order: "pre",
            handler: () =>
              Effect.sync(() => {
                seen.push("override")
                return Option.some<ErrorClass>("permanent")
              })
          }
        }
      }
    ])
    const result = await run(dispatcher.first("classifyError", new Error("x"), { runId: "r", stepKey: "s" }))
    expect(result).toEqual(Option.some("permanent"))
    expect(seen).toEqual(["override"])
  })

  it("ignores a non-Option answer rather than short-circuiting on it", async () => {
    const dispatcher = await dispatcherFor([
      { name: "rogue", hooks: { resolveShareability: () => Effect.succeed("nonsense" as never) } },
      { name: "sane", hooks: { resolveShareability: () => Effect.succeed(Option.some({ shareable: true })) } }
    ])
    const result = await run(dispatcher.first("resolveShareability", { tier: "sealed", boundaryMode: "hard" }))
    expect(result).toEqual(Option.some({ shareable: true }))
  })

  it("fails with hook_failed when a first handler fails", async () => {
    const dispatcher = await dispatcherFor([
      { name: "bad", hooks: { resolveRetry: () => Effect.fail("nope") } }
    ])
    const error = await run(
      dispatcher.first("resolveRetry", {
        attempt: 2,
        error: new Error("x"),
        classification: "transient",
        activity: { name: "a" }
      }).pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
  })
})
