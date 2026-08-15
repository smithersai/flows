/**
 * Pi/OpenCode batch-stop parity.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Elaborate from "../src/Elaborate.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Steering from "../src/Steering.ts"
import * as Turn from "../src/Turn.ts"
import { make as makeModel, type Step, stopNoTools } from "./fixtures/scriptedModel.ts"

// Turn.test.ts covers a single truncated call. This pin covers batch atomicity and the next request.
const alpha = ModelRequest.ToolDefinition.make({ name: "alpha", description: "alpha", parameters: {} })
const beta = ModelRequest.ToolDefinition.make({ name: "beta", description: "beta", parameters: {} })
const lengthBatch: Step = {
  events: [
    ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "length-a", name: "alpha" }),
    ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "length-a", arguments: "{\"value\":\"one\"}" }),
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "length-a" }),
    ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "length-b", name: "beta" }),
    ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: "length-b", arguments: "{\"value\":\"two\"}" }),
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: "length-b" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "length" })
  ]
}

describe("length stop batch", () => {
  it("rejects the whole batch without a splice and carries paired typed errors into the next request", async () => {
    const model = makeModel([lengthBatch, stopNoTools])
    const splices: Array<unknown> = []
    const engine = EngineLike.make({
      sealStep: ({ request }) => model.model.stream(request),
      splice: (batch) =>
        Stream.fromEffect(Effect.sync(() => splices.push(batch))).pipe(
          Stream.drain
        ),
      call: () => Effect.die("this fixture drives the tool-call path, not cells"),
      record: (boundary) => boundary.execute,
      suspend: () => Effect.die("unexpected suspension")
    })
    const context = ContextWindow.make({
      modelId: "model",
      segments: [
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "system" })] },
        { kind: "tools", zone: "prefix", content: [alpha, beta] },
        { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("start")] }
      ],
      activeTools: ["alpha", "beta"]
    })
    const catalog: Elaborate.Catalog = {
      tools: Object.fromEntries(["alpha", "beta"].map((name) => [name, {
        flowName: name,
        input: Schema.Struct({ value: Schema.String }),
        capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none()
      }]))
    }
    const events = await Effect.runPromise(
      Turn.run({
        state: Turn.make({
          seat: "fixture:model",
          modelParams: ModelRequest.GenerationParams.make(),
          layers: [],
          capabilityEnvelope: [],
          placement: Option.none(),
          contextWindow: context
        }),
        catalog
      }).pipe(Stream.runCollect, Effect.provide(EngineLike.layer(engine)), Effect.provide(Steering.layerNoop()))
    )
    const children = Array.from(events).filter((event): event is AgentEvent.ChildResult =>
      event._tag === "child-result"
    )

    expect(splices).toEqual([])
    expect(children.map((event) => [event.result.callId, event.result.outcome])).toEqual([
      ["length-a", "error"],
      ["length-b", "error"]
    ])
    expect(children.every((event) => event.result.result.content.includes("truncated"))).toBe(true)
    expect(model.recorder.requests).toHaveLength(2)
    const resumed = model.recorder.requests[1]
    expect(resumed?.messages.find((message) => message.role === "tool")).toMatchObject({
      content: [{ toolCallId: "length-a" }, { toolCallId: "length-b" }]
    })
  })
})
