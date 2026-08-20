/**
 * The Node seat resolver: `provider:modelId` seats into live model routes,
 * with keys read from an environment record and never hardcoded.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import { Seat } from "@smthrs/agent"
import { Control } from "@smthrs/control"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

describe("NodeControl.seatResolver", () => {
  const unusedExecutor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die(new Error("model transport was not expected"))
  })

  it("refuses a seat whose provider has no route", async () => {
    const error = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("mystery:model-x"))
    )
    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.message).toContain("mystery")
  })

  it("refuses a seat whose key variable is unset, naming the variable", async () => {
    const anthropic = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("anthropic:claude-sonnet-4-5"))
    )
    expect(anthropic.message).toContain("ANTHROPIC_API_KEY")

    const openai = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("openai:gpt-5"))
    )
    expect(openai.message).toContain("OPENAI_API_KEY")

    const openrouter = await Effect.runPromise(
      Effect.flip(NodeControl.seatResolver({}, unusedExecutor).resolve("openrouter:openai/gpt-5.6-sol"))
    )
    expect(openrouter.message).toContain("OPENROUTER_API_KEY")
  })

  it("resolves an openrouter seat through the compatible route with the slashed model id intact", async () => {
    const seat = await Effect.runPromise(
      Effect.scoped(
        NodeControl.seatResolver({ OPENROUTER_API_KEY: "test-key" }, unusedExecutor).resolve(
          "openrouter:openai/gpt-5.6-sol"
        )
      )
    )
    // gpt-5-class ids resolve the 400k window regardless of the vendor prefix.
    expect(seat.contextWindowTokens).toBe(400_000)
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
      NodeControl.seatResolver({ ANTHROPIC_API_KEY: "test-key" }, unusedExecutor).resolve("anthropic:claude-sonnet-4-5")
    )
    // The window comes from the model catalog, so compaction is armed rather
    // than silently disabled at zero.
    expect(seat.contextWindowTokens).toBe(200_000)
    // The resolved record carries the seat it was declared as, which is what
    // the agent stamps onto every turn.
    expect(seat.id).toBe("anthropic:claude-sonnet-4-5")
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

  it("keeps the live model transport open while a resolved seat streams", async () => {
    const sse = [
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"live\"}",
      "",
      "event: response.output_text.done",
      "data: {\"type\":\"response.output_text.done\",\"item_id\":\"msg_1\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\"}}",
      "",
      ""
    ].join("\n")
    const agent = new MockAgent()
    agent.disableNetConnect()
    agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(200, sse, {
      headers: { "content-type": "text/event-stream" }
    })
    const transport = await Effect.runPromise(
      NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
    )
    const executor = await Effect.runPromise(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, transport))
    )
    try {
      const events = await Effect.runPromise(
        Effect.scoped(
          NodeControl.seatResolver({ OPENAI_API_KEY: "test-key" }, executor).resolve("openai:gpt-4o-mini").pipe(
            Effect.flatMap((seat) =>
              seat.model.stream({
                modelId: "gpt-4o-mini",
                system: [],
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
                tools: [],
                params: {}
              }).pipe(Stream.runCollect)
            )
          )
        )
      )

      expect(Array.from(events)).toContainEqual({ type: "text-delta", id: "msg_1", text: "live" })
      expect(agent.assertNoPendingInterceptors()).toBeUndefined()
    } finally {
      await agent.close()
    }
  })
})
