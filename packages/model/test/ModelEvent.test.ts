import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/ModelEvent.ts"

describe("ModelEvent", () => {
  it("round-trips every event", () => {
    const events: ReadonlyArray<Events.ModelEvent> = [
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "hello" },
      { type: "text-end", id: "text" },
      { type: "thinking-start", id: "thinking", signature: "sig" },
      { type: "thinking-delta", id: "thinking", text: "consider" },
      { type: "thinking-end", id: "thinking" },
      { type: "tool-call-start", id: "call", name: "read" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call" },
      { type: "tool-result", id: "call", output: "file contents", isError: false },
      {
        type: "usage",
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cachedInputTokens: 4,
        cacheWriteTokens: 5,
        totalTokens: 6
      },
      { type: "settle", stopReason: "stop" }
    ]
    for (const event of events) {
      expect(Schema.decodeUnknownSync(Events.ModelEvent)(Schema.encodeSync(Events.ModelEvent)(event))).toEqual(event)
    }
  })

  it("folds accumulated stream content on settlement", () => {
    const settled = Events.settledMessage([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "hello" },
      { type: "thinking-start", id: "thinking", signature: "sig" },
      { type: "thinking-delta", id: "thinking", text: "think" },
      { type: "tool-call-start", id: "call", name: "read" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":\"a\"}" },
      { type: "usage", totalTokens: 9 },
      { type: "settle", stopReason: "tool-calls" }
    ])
    expect(settled.message).toMatchObject({
      role: "assistant",
      stopReason: "tool-calls",
      content: [
        { type: "text", text: "hello" },
        { type: "thinking", text: "think", signature: "sig" },
        { type: "tool-call", id: "call", name: "read", arguments: "{\"path\":\"a\"}" }
      ]
    })
    expect(settled.usage).toEqual({ totalTokens: 9 })
  })

  it("encodes a missing settle as aborted", () => {
    expect(Events.settledMessage([{ type: "text-delta", id: "text", text: "partial" }]).message).toMatchObject({
      stopReason: "aborted",
      content: [{ type: "text", text: "partial" }]
    })
  })

  it("repairs interrupted tool JSON and preserves settlement metadata", () => {
    const settled = Events.settledMessage([
      { type: "tool-call-start", id: "call", name: "write" },
      { type: "tool-call-delta", id: "call", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call", arguments: "{}" },
      { type: "usage", inputTokens: 2 },
      { type: "usage", outputTokens: 3, totalTokens: 5 },
      {
        type: "settle",
        stopReason: "tool-calls",
        responseId: "response",
        itemIds: ["item"]
      }
    ])

    expect(settled.message).toMatchObject({
      stopReason: "tool-calls",
      responseId: "response",
      itemIds: ["item"],
      content: [{ type: "tool-call", id: "call", name: "write", arguments: "{}" }]
    })
    expect(settled.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
  })
})
