/**
 * The Node seat resolver: `provider:modelId` seats into live model routes,
 * with keys read from an environment record and never hardcoded.
 */
import { Control } from "@smthrs/control"
import { HarnessExecutor } from "@smthrs/engine-harness"
import type { Layer } from "effect"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

describe("NodeControl.resolveSeat", () => {
  it("refuses a seat whose provider has no route", async () => {
    const error = await Effect.runPromise(
      Effect.flip(NodeControl.resolveSeat({})("mystery:model-x"))
    )
    expect(error).toBeInstanceOf(HarnessExecutor.SeatUnresolved)
    expect(error.message).toContain("mystery")
  })

  it("refuses a seat whose key variable is unset, naming the variable", async () => {
    const anthropic = await Effect.runPromise(
      Effect.flip(NodeControl.resolveSeat({})("anthropic:claude-sonnet-4-5"))
    )
    expect(anthropic.message).toContain("ANTHROPIC_API_KEY")

    const openai = await Effect.runPromise(
      Effect.flip(NodeControl.resolveSeat({})("openai:gpt-5"))
    )
    expect(openai.message).toContain("OPENAI_API_KEY")
  })

  it("boots the full local composition with the production executor provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-executor-"))
    try {
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, {})
      // Building this layer migrates the durable engine, registers the agent
      // flow, starts the resume bridge, and migrates the memory store over the
      // control database — the whole local `flows run` composition, minus a
      // provider.
      const flowId = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          return card.flowId
        }).pipe(
          Effect.provide(
            Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>
          ),
          Effect.scoped,
          Effect.orDie
        )
      )
      expect(flowId).toBe("system/test")
      expect(existsSync(NodeControl.executionDatabasePath(root))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves a keyed anthropic seat into a route and a nonzero context window", async () => {
    const seat = await Effect.runPromise(
      NodeControl.resolveSeat({ ANTHROPIC_API_KEY: "test-key" })("anthropic:claude-sonnet-4-5")
    )
    // The window comes from the model catalog, so compaction is armed rather
    // than silently disabled at zero.
    expect(seat.contextWindowTokens).toBe(200_000)
    const preparedRequest = await Effect.runPromise(
      seat.route.prepare({
        modelId: "claude-sonnet-4-5",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        params: {}
      } as never)
    )
    // The prepared view is credential-free: the key is applied by Auth at
    // send time and never enters the sealed request.
    expect(preparedRequest.url).toContain("api.anthropic.com")
    expect(JSON.stringify(preparedRequest.publicHeaders)).not.toContain("test-key")
  })
})
