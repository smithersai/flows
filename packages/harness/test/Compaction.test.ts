import { ModelRequest } from "@smthrs/model"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Compaction from "../src/Compaction.ts"
import { ContextWindow } from "../src/ContextWindow.ts"

const message = (text: string) => ModelRequest.Message.assistant(text, { stopReason: "stop" })

const segment = (text: string, tokens: number) => ({
  kind: "transcript" as const,
  zone: "tail" as const,
  content: [message(text)],
  tokens: { value: tokens, estimated: false }
})

const window = () =>
  ContextWindow.make({
    modelId: "model",
    segments: [segment("first", 12_000), segment("middle", 12_000), segment("suffix", 20_000)]
  })

const summarizer: Compaction.Summarizer = {
  identity: "summary-v1",
  modelId: "summary-model",
  params: ModelRequest.GenerationParams.make({ temperature: 0 })
}

describe("Compaction", () => {
  it("triggers only after capacity minus the reserve", () => {
    const contextWindow = 100_000
    expect(Compaction.shouldCompact({ total: { value: 84_000 }, contextWindow })).toBe(false)
    expect(Compaction.shouldCompact({ total: { value: 83_999 }, contextWindow })).toBe(false)
    expect(Compaction.shouldCompact({ total: { value: 84_001 }, contextWindow })).toBe(true)
    expect(Compaction.shouldCompact({ total: { value: 1 }, contextWindow: 0 })).toBe(false)
  })

  it("keeps at least the configured recent token suffix", () => {
    const input = window()
    const prefixLength = Compaction.selectPrefix(input, { keepRecent: 20_000 })
    const compactable = input.segments.filter((item) => item.kind === "transcript")
    expect(prefixLength).toBe(2)
    expect(compactable.slice(prefixLength).reduce((sum, item) => sum + item.tokens.value, 0)).toBeGreaterThanOrEqual(
      20_000
    )
  })

  it("does not split a tool-call and tool-result pair at the cut", () => {
    const call = ModelRequest.Message.assistant(
      ModelRequest.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{}" }),
      { stopReason: "tool-calls" }
    )
    const result = ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "call-1", content: "ok" }))
    const input = ContextWindow.make({
      modelId: "model",
      segments: [
        segment("old", 10),
        { kind: "transcript", zone: "tail", content: [call], tokens: { value: 10, estimated: false } },
        { kind: "transcript", zone: "tail", content: [result], tokens: { value: 10, estimated: false } },
        segment("recent", 10)
      ]
    })
    expect(Compaction.selectPrefix(input, { keepRecent: 20 })).toBe(1)
  })

  it("extends a prior summary and preserves the uncompacted suffix", () => {
    const input = window()
    const first = Effect.runSync(Compaction.declare(input, 1, summarizer))
    const once = Effect.runSync(Compaction.apply(input, first, message("summary one")))
    const second = Effect.runSync(Compaction.declare(once, 2, summarizer))
    const request = Effect.runSync(Compaction.summaryRequest(once, second))
    const twice = Effect.runSync(Compaction.apply(once, second, message("summary two")))

    expect(
      request.messages.flatMap((item) => [...item.content]).some((item) =>
        item.type === "text" && item.text === "summary one"
      )
    ).toBe(true)
    expect(request.system.map((part) => part.text)).toContain(Compaction.summaryInstruction)
    expect(twice.segments.at(-1)?.digest).toBe(once.segments.at(-1)?.digest)
    expect(twice.segments.filter((item) => item.kind === "summary")).toHaveLength(1)
  })

  it("reports invalid declarations through the typed error channel", () => {
    const error = Effect.runSync(Compaction.declare(window(), 0, summarizer).pipe(Effect.flip))
    expect(error).toBeInstanceOf(Compaction.InvalidStep)
  })
})
