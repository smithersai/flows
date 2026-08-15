import { describe, expect, it } from "vitest"
import * as DeferredTools from "../src/DeferredTools.ts"
import { Message, ModelRequest, ToolDefinition } from "../src/ModelRequest.ts"

const tool = (
  name: string,
  options: { readonly deferred?: boolean; readonly loader?: boolean; readonly metadata?: string } = {}
): ToolDefinition =>
  Object.assign(
    ToolDefinition.make({
      name,
      description: `${name} description`,
      parameters: { type: "object" },
      deferred: options.deferred,
      loader: options.loader
    }),
    options.metadata === undefined ? {} : { promptSnippet: options.metadata }
  )

const request = (tools: ReadonlyArray<ToolDefinition>, messages: ReadonlyArray<Message> = []): ModelRequest =>
  ModelRequest.make({ modelId: "model", system: [], messages, tools, params: {} })

describe("DeferredTools", () => {
  it("uses pi's exact native-support matrix", () => {
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-5")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-opus-4-6")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-fable-4.5")).toBe(true)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-haiku-4-5")).toBe(false)
    expect(DeferredTools.supportsDeferred("anthropic-messages", "claude-sonnet-4-20250514")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4-mini")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4-pro")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.5")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.6-sol")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.6-terra")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.6-luna")).toBe(true)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.4-nano")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.5-pro")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-6")).toBe(false)
    expect(DeferredTools.supportsDeferred("openai-responses", "gpt-5.3")).toBe(false)
  })

  it("deduplicates normalized names and preserves a tool used before its marker", () => {
    const late = tool("Late", { deferred: true })
    const messages = [
      Message.assistant({ type: "tool-call", id: "call", name: "late", arguments: "{}" }),
      Message.tool({ type: "tool-result", toolCallId: "call", content: "done", addedToolNames: ["LATE"] })
    ]
    const result = DeferredTools.resolve(request([tool("base"), late, tool(" late ")], messages), true)
    expect(result.immediate.map((entry) => entry.name)).toEqual(["base", "Late"])
    expect(result.deferred).toEqual([])
    expect(result.activatedNames).toEqual(["Late"])
  })

  it("keeps declared lazy tools deferred before their first activation marker", () => {
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late", { deferred: true })]),
      true
    )

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late"])
    expect(result.activatedNames).toEqual([])
  })

  it("keeps activations additive, loader tools immediate, and does not resurrect missing tools", () => {
    const messages = [
      Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] }),
      Message.tool({ type: "tool-result", toolCallId: "two", content: "", addedToolNames: ["later", "removed"] })
    ]
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late"), tool("later")], messages),
      true
    )
    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late", "later"])
    expect(result.activatedNames).toEqual(["late", "later"])
  })

  it("keeps a tool deferred when a later loader result repeats its post-use activation marker", () => {
    const messages = [
      Message.tool({ type: "tool-result", toolCallId: "load", content: "", addedToolNames: ["late"] }),
      Message.assistant({ type: "tool-call", id: "use", name: "late", arguments: "{}" }, {
        stopReason: "tool-calls"
      }),
      Message.tool({
        type: "tool-result",
        toolCallId: "load-again",
        content: "",
        addedToolNames: ["LATE"]
      })
    ]
    const result = DeferredTools.resolve(request([tool("loader", { loader: true }), tool("late")], messages), true)

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred.map((entry) => entry.name)).toEqual(["late"])
    expect(result.activatedNames).toEqual(["late"])
  })

  it("promotes all lazy tools if native loading leaves no immediate tool", () => {
    const messages = [Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] })]
    const result = DeferredTools.resolve(request([tool("late")], messages), true)
    expect(result.immediate.map((entry) => entry.name)).toEqual(["late"])
    expect(result.deferred).toEqual([])
    expect(result.activatedNames).toEqual([])
  })

  it("uses the complete active list when native loading is unavailable", () => {
    const messages = [Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] })]
    const result = DeferredTools.resolve(request([tool("base"), tool("late", { deferred: true })], messages), false)
    expect(result.immediate.map((entry) => entry.name)).toEqual(["base", "late"])
    expect(result.deferred).toEqual([])
  })

  it("omits inactive deferred definitions from the unsupported-model fallback", () => {
    const result = DeferredTools.resolve(
      request([tool("loader", { loader: true }), tool("late", { deferred: true })]),
      false
    )

    expect(result.immediate.map((entry) => entry.name)).toEqual(["loader"])
    expect(result.deferred).toEqual([])
  })

  it("strips prompt-affecting metadata from lazy entries", () => {
    const late = tool("late", { metadata: "must never reach a provider prefix" })
    const messages = [Message.tool({ type: "tool-result", toolCallId: "one", content: "", addedToolNames: ["late"] })]
    const result = DeferredTools.resolve(request([tool("base"), late], messages), true)
    expect(result.deferred[0]).toEqual({
      name: "late",
      description: "late description",
      parameters: { type: "object" },
      deferred: undefined,
      loader: undefined
    })
    expect(result.deferred[0]).not.toHaveProperty("promptSnippet")
  })
})
