import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Request from "../src/ModelRequest.ts"

describe("ModelRequest", () => {
  it("round-trips every request part without changing order", () => {
    const request = Request.ModelRequest.make({
      modelId: "provider/model",
      system: [Request.SystemPart.make({ text: "system" })],
      messages: [
        Request.Message.user([Request.TextPart.make({ text: "question" })]),
        Request.Message.assistant([
          Request.TextPart.make({ text: "answer" }),
          Request.ThinkingPart.make({ text: "reasoning", signature: "signature" }),
          Request.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{\"path\":\"a\"}" })
        ], { responseId: "response-1", itemIds: ["item-1"], stopReason: "tool-calls" }),
        Request.Message.tool(Request.ToolResultPart.make({
          toolCallId: "call-1",
          content: "contents",
          addedToolNames: ["search", "read"]
        }))
      ],
      tools: [
        Request.ToolDefinition.make({
          name: "search",
          description: "Search",
          parameters: { type: "object" },
          deferred: true
        }),
        Request.ToolDefinition.make({ name: "read", description: "Read", parameters: { type: "object" }, loader: true })
      ],
      params: Request.GenerationParams.make({
        maxTokens: 100,
        temperature: 0.1,
        topP: 0.9,
        topK: 10,
        stopSequences: ["END"],
        thinkingBudget: 20,
        reasoningEffort: "high"
      })
    })
    const encoded = Schema.encodeSync(Request.ModelRequest)(request)
    const decoded = Schema.decodeUnknownSync(Request.ModelRequest)(encoded)

    expect(decoded).toEqual(request)
    expect(decoded.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(decoded.tools.map((tool) => tool.name)).toEqual(["search", "read"])
  })

  it("rejects non-text user content instead of silently dropping it", () => {
    expect(() =>
      Schema.decodeUnknownSync(Request.ModelRequest)({
        modelId: "provider/model",
        system: [],
        messages: [{
          role: "user",
          content: [{ type: "thinking", text: "not user content" }]
        }],
        tools: [],
        params: {}
      })
    ).toThrow()
  })

  it("rejects non-JSON values anywhere in tool parameter schemas", () => {
    const make = (parameters: unknown) => ({
      modelId: "provider/model",
      system: [],
      messages: [],
      tools: [{ name: "invalid", description: "invalid", parameters }],
      params: {}
    })

    for (
      const parameters of [
        new Date(0),
        new Map([["key", "value"]]),
        { type: "number", multipleOf: Number.NaN },
        { type: "object", generatedAt: new Date(0) },
        { type: "object", metadata: new Map([["key", "value"]]) }
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(Request.ModelRequest)(make(parameters))).toThrow()
    }
  })
})
