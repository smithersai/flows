/**
 * Pi §4 parity: `docs/specs/Research/Pi Reference Findings 2026-07-27.md`.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import { DeferredTools, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Assemble from "../src/Assemble.ts"
import * as Elaborate from "../src/Elaborate.ts"
import * as EngineLike from "../src/EngineLike.ts"
import * as Plan from "../src/Plan.ts"
import * as Steering from "../src/Steering.ts"
import * as Turn from "../src/Turn.ts"

const loaderStep: ReadonlyArray<ModelEvent.ModelEvent> = [
  ModelEvent.ModelEvent.ToolCallStart({
    type: "tool-call-start",
    id: "load-lazy",
    name: "search_tools"
  }),
  ModelEvent.ModelEvent.ToolCallDelta({
    type: "tool-call-delta",
    id: "load-lazy",
    arguments: "{\"query\":\"lazy\"}"
  }),
  ModelEvent.ModelEvent.ToolCallEnd({
    type: "tool-call-end",
    id: "load-lazy"
  }),
  ModelEvent.ModelEvent.Settle({
    type: "settle",
    stopReason: "tool-calls"
  })
]

const finalStep: ReadonlyArray<ModelEvent.ModelEvent> = [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "final" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "final", text: "done" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "final" }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

describe("deferred activation integration", () => {
  it("retains an inactive definition from Assemble through the next Turn request", async () => {
    const loader = ModelRequest.ToolDefinition.make({
      name: "search_tools",
      description: "Search for tools",
      parameters: { type: "object" },
      loader: true
    })
    const lazy = ModelRequest.ToolDefinition.make({
      name: "lazy",
      description: "Run the lazy flow",
      parameters: { type: "object" },
      deferred: true
    })
    const assembled = Assemble.assemble({
      journal: [],
      system: { text: "system", digest: "system" },
      instructions: [],
      prompt: { text: "prompt", digest: "prompt" },
      modelId: "gpt-5.4",
      params: ModelRequest.GenerationParams.make(),
      flowInput: {},
      activeToolNames: ["search_tools"],
      toolDefinitions: [loader, lazy],
      registry: []
    })
    const requests: Array<ModelRequest.ModelRequest> = []
    let modelStep = 0
    const engine = EngineLike.make({
      sealStep: ({ request }) => {
        requests.push(request)
        return Stream.fromIterable(modelStep++ === 0 ? loaderStep : finalStep)
      },
      splice: () =>
        Stream.succeed(
          new Plan.ChildSettled({
            result: new Plan.ChildResult({
              callId: "load-lazy",
              outcome: "success",
              result: ModelRequest.ToolResultPart.make({
                toolCallId: "load-lazy",
                content: "Loaded lazy",
                addedToolNames: ["lazy"]
              })
            })
          })
        ),
      call: () => Effect.die("this fixture drives the tool-call path, not cells"),
      record: (boundary) => boundary.execute,
      suspend: (reason) => Effect.die(`unexpected suspension: ${reason.code}`)
    })
    const catalog: Elaborate.Catalog = {
      tools: {
        search_tools: {
          flowName: "search_tools",
          input: Schema.Struct({ query: Schema.String }),
          capabilities: [],
          effects: {
            reads: [],
            writes: [],
            mode: "hermetic",
            onConflict: "serialize",
            tier: "sealed"
          },
          placement: Option.none()
        }
      }
    }

    await Effect.runPromise(
      Turn.run({
        state: Turn.make({
          seat: "sdk:gpt-5.4",
          modelParams: ModelRequest.GenerationParams.make(),
          layers: ["model:test"],
          capabilityEnvelope: [],
          placement: Option.none(),
          contextWindow: assembled
        }),
        catalog
      }).pipe(
        Stream.runCollect,
        Effect.provide(EngineLike.layer(engine)),
        Effect.provide(Steering.layerNoop())
      )
    )

    expect(requests).toHaveLength(2)
    const firstRequest = requests[0]
    const secondRequest = requests[1]
    expect(firstRequest).toBeDefined()
    expect(secondRequest).toBeDefined()
    if (firstRequest === undefined || secondRequest === undefined) return

    expect(DeferredTools.resolve(firstRequest, false).immediate.map((tool) => tool.name)).toEqual(["search_tools"])
    expect(DeferredTools.resolve(secondRequest, false).immediate.map((tool) => tool.name)).toEqual([
      "search_tools",
      "lazy"
    ])
    expect(DeferredTools.resolve(secondRequest, true).deferred.map((tool) => tool.name)).toEqual(["lazy"])
    expect(secondRequest.tools).toContainEqual(lazy)
  })
})
