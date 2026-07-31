import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import type { ParallelHook, SequentialHook } from "../src/Hooks.ts"
import * as Hooks from "../src/Hooks.ts"
import type { FlowsPlugin } from "../src/index.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

interface ToolCallContext {
  readonly tool: string
}
interface ToolOverride {
  readonly replaceWith: string
}
interface TurnContext {
  readonly turn: number
}

// The harness seam: exactly the `declare module` form the spec documents,
// pointed at this package's entry module.
declare module "../src/index.ts" {
  interface FlowsHooks {
    readonly toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
    readonly agentTurnStart: ParallelHook<(turn: TurnContext) => Effect.Effect<void>>
  }
}

const harnessHooks = {
  ...Hooks.engineHooks,
  toolCall: "sequential",
  agentTurnStart: "parallel"
} as const satisfies Record<string, Hooks.HookKind>

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

describe("module augmentation", () => {
  it("lets one plugin object carry engine and harness hooks, dispatched by two dispatchers", async () => {
    const trace: Array<string> = []
    const both: FlowsPlugin = {
      name: "flows-plugin-both",
      hooks: {
        runStart: () => Effect.sync(() => void trace.push("engine:runStart")),
        toolCall: (ctx) =>
          Effect.sync(() => {
            trace.push(`harness:toolCall:${ctx.tool}`)
            return Option.some({ replaceWith: "safe-tool" })
          }),
        agentTurnStart: (turn) => Effect.sync(() => void trace.push(`harness:turn:${turn.turn}`))
      }
    }

    // The engine's dispatcher: engine catalog only, so the harness keys are a
    // startup error here — engine hosts pass engine plugins.
    const rejected = await run(Resolve.resolve([both]).pipe(Effect.flip))
    expect(rejected.code).toBe("unknown_hook")

    // A host that declares the augmented catalog resolves the same object.
    const resolved = await run(Resolve.resolve([both], { hooks: harnessHooks }))

    const engine = Plugins.make(resolved)
    await run(engine.parallel("runStart", { runId: "r" }))

    const harness = Plugins.make(resolved)
    const override = await run(harness.sequential("toolCall", { tool: "bash" }))
    await run(harness.parallel("agentTurnStart", { turn: 1 }))

    expect(override).toEqual([Option.some({ replaceWith: "safe-tool" })])
    expect(trace).toEqual(["engine:runStart", "harness:toolCall:bash", "harness:turn:1"])
  })
})
