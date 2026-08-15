import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as AnthropicMessages from "../src/AnthropicMessages.ts"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import { ModelError } from "../src/ModelError.ts"
import { ModelEvent } from "../src/ModelEvent.ts"
import {
  GenerationParams,
  Message,
  ModelRequest,
  SystemPart,
  ThinkingPart,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart
} from "../src/ModelRequest.ts"

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/anthropic/${name}.sse`, import.meta.url), "utf8")

const frames = (source: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> =>
  source
    .trim()
    .split(/\r?\n\r?\n/)
    .map((record) => {
      const event = record
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim()
      const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n")
      return {
        ...(event === undefined ? {} : { event }),
        data
      }
    })

const streamRequest = ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [],
  tools: [],
  params: GenerationParams.make()
})

const step = (
  state: ReturnType<typeof AnthropicMessages.protocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(data)
  return Effect.runSync(AnthropicMessages.protocol.stream.step(state, event))
}

const body = (request: ModelRequest, native = true): AnthropicMessages.Body =>
  Effect.runSync(AnthropicMessages.protocol.body.from(request, { native }))

const run = (name: string, finalize = false) => {
  let state = AnthropicMessages.protocol.stream.initial(streamRequest)
  const events: Array<ModelEvent> = []
  for (const frame of frames(fixture(name))) {
    const [next, emitted] = step(state, frame.data)
    state = next
    events.push(...emitted)
  }
  if (finalize) events.push(...(AnthropicMessages.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const tool = (
  name: string,
  input: {
    readonly deferred?: boolean
    readonly loader?: boolean
    readonly reverseProperties?: boolean
  } = {}
): ToolDefinition =>
  ToolDefinition.make({
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: input.reverseProperties
        ? { days: { type: "number" }, city: { type: "string" } }
        : { city: { type: "string" }, days: { type: "number" } }
    },
    deferred: input.deferred,
    loader: input.loader
  })

const activatedRequest = (
  modelId: string,
  input: { readonly reverseRequest?: boolean; readonly reverseProperties?: boolean } = {}
): ModelRequest => {
  const reverse = input.reverseProperties
  const loader = tool("search_tools", {
    loader: true,
    ...(reverse !== undefined ? { reverseProperties: reverse } : {})
  })
  const weather = tool("weather", { deferred: true, ...(reverse !== undefined ? { reverseProperties: reverse } : {}) })
  const call = ToolCallPart.make({ id: "toolu_loader", name: "search_tools", arguments: "{\"query\":\"weather\"}" })
  const result = ToolResultPart.make({
    toolCallId: "toolu_loader",
    content: "Found weather",
    addedToolNames: ["weather"]
  })
  const values = input.reverseRequest
    ? {
      params: GenerationParams.make({ maxTokens: 512, temperature: 0.2 }),
      tools: [loader, weather],
      messages: [
        Message.assistant(call, { stopReason: "tool-calls" }),
        Message.tool(result)
      ],
      system: [SystemPart.make({ text: "Be concise." })],
      modelId
    }
    : {
      modelId,
      system: [SystemPart.make({ text: "Be concise." })],
      messages: [
        Message.assistant(call, { stopReason: "tool-calls" }),
        Message.tool(result)
      ],
      tools: [loader, weather],
      params: GenerationParams.make({ maxTokens: 512, temperature: 0.2 })
    }
  return ModelRequest.make(values)
}

describe("AnthropicMessages streaming", () => {
  it("parses text and settles exactly once", () => {
    const events = run("text")
    expect(events).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "Hello" },
      { type: "text-delta", id: "text-0", text: ", world" },
      { type: "text-end", id: "text-0" },
      { type: "usage", inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      { type: "settle", stopReason: "stop", responseId: "msg_text" }
    ])
    expect(events.filter((event) => event.type === "settle")).toHaveLength(1)
    expect(ModelEvent.settledMessage(events).message).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Hello, world" }]
    })
  })

  it("accumulates fragmented tool arguments", () => {
    const events = run("tool-call")
    expect(events).toEqual([
      { type: "tool-call-start", id: "toolu_01", name: "weather" },
      { type: "tool-call-delta", id: "toolu_01", arguments: "{\"city\":" },
      { type: "tool-call-delta", id: "toolu_01", arguments: "\"Paris\"}" },
      { type: "tool-call-end", id: "toolu_01", arguments: "{\"city\":\"Paris\"}" },
      { type: "usage", inputTokens: 18, outputTokens: 9, totalTokens: 27 },
      { type: "settle", stopReason: "tool-calls", responseId: "msg_tool" }
    ])
    expect(ModelEvent.settledMessage(events).message.content).toEqual([
      {
        type: "tool-call",
        id: "toolu_01",
        name: "weather",
        arguments: "{\"city\":\"Paris\"}"
      }
    ])
  })

  it("attaches a late signature to the complete thinking block", () => {
    const data = [
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Inspect\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_01\"}}",
      "{\"type\":\"content_block_stop\",\"index\":0}",
      "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}",
      "{\"type\":\"message_stop\"}"
    ]
    let state = AnthropicMessages.protocol.stream.initial(streamRequest)
    const events: Array<ModelEvent> = []
    for (const datum of data) {
      const [next, emitted] = step(state, datum)
      state = next
      events.push(...emitted)
    }
    expect(events).toEqual([
      { type: "thinking-start", id: "thinking-0", signature: "sig_01" },
      { type: "thinking-delta", id: "thinking-0", text: "Inspect" },
      { type: "thinking-end", id: "thinking-0" },
      { type: "settle", stopReason: "stop" }
    ])
    expect(ModelEvent.settledMessage(events).message.content).toEqual([
      { type: "thinking", text: "Inspect", signature: "sig_01" }
    ])
  })

  it("merges Anthropic's cache-aware usage reports", () => {
    const events = run("usage")
    expect(events).toEqual([
      {
        type: "usage",
        inputTokens: 34,
        outputTokens: 4,
        cachedInputTokens: 8,
        cacheWriteTokens: 5,
        totalTokens: 38
      },
      { type: "settle", stopReason: "stop", responseId: "msg_usage" }
    ])
    expect(ModelEvent.settledMessage(events).usage).toEqual({
      inputTokens: 34,
      outputTokens: 4,
      reasoningTokens: undefined,
      cachedInputTokens: 8,
      cacheWriteTokens: 5,
      totalTokens: 38
    })
  })

  it("flushes an open tool call without settling an interrupted stream", () => {
    const events = run("abort-mid-stream", true)
    expect(events).toEqual([
      { type: "tool-call-start", id: "toolu_abort", name: "lookup" },
      { type: "tool-call-delta", id: "toolu_abort", arguments: "{\"query\":\"par" },
      { type: "tool-call-end", id: "toolu_abort", arguments: "{}" }
    ])
    expect(events.some((event) => event.type === "settle")).toBe(false)
    expect(ModelEvent.settledMessage(events).message).toMatchObject({
      stopReason: "aborted",
      content: [
        {
          type: "tool-call",
          id: "toolu_abort",
          name: "lookup",
          arguments: "{}"
        }
      ]
    })

    const followUp = ModelRequest.make({
      modelId: "claude-sonnet-4-5",
      system: [],
      messages: [ModelEvent.settledMessage(events).message, Message.user("continue")],
      tools: [],
      params: GenerationParams.make()
    })
    const requestBody = body(followUp)
    expect(CanonicalJson.stringify(requestBody)).not.toContain("toolu_abort")
    expect(CanonicalJson.stringify(requestBody)).not.toContain("{\\\"query\\\":")
  })

  it("maps stream error events to ModelError", () => {
    const frame = {
      event: "error",
      data: "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
    }
    const event = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(frame.data)
    const error = Effect.runSync(
      AnthropicMessages.protocol.stream
        .step(AnthropicMessages.protocol.stream.initial(streamRequest), event)
        .pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: "provider_internal", providerCode: "overloaded_error" })
  })
})

describe("AnthropicMessages body lowering", () => {
  it("produces byte-identical canonical bodies from differently ordered inputs", () => {
    const left = body(activatedRequest("claude-sonnet-4-5"))
    const right = body(activatedRequest("claude-sonnet-4-5", {
      reverseRequest: true,
      reverseProperties: true
    }))
    expect(CanonicalJson.stringify(left)).toBe(CanonicalJson.stringify(right))
  })

  it("emits pi's exact nested tool-reference wire shape", () => {
    const requestBody = body(activatedRequest("claude-sonnet-4-5"))

    // Pi findings §4: these literals are the provider's exact wire extension.
    expect(requestBody.tools).toEqual([
      {
        name: "search_tools",
        description: "search_tools description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        }
      },
      {
        name: "weather",
        description: "weather description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        },
        defer_loading: true
      }
    ])
    expect(requestBody.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_loader",
          content: [{
            type: "tool_reference",
            tool_name: "weather"
          }]
        },
        {
          type: "text",
          text: "Found weather"
        }
      ]
    })
    expect(Object.keys(requestBody.tools?.[1] ?? {}).sort()).toEqual([
      "defer_loading",
      "description",
      "input_schema",
      "name"
    ])
  })

  it("marks an unactivated declared tool as lazy on the initial native request", () => {
    const requestBody = body(
      ModelRequest.make({
        modelId: "claude-sonnet-4-5",
        system: [],
        messages: [],
        tools: [
          tool("search_tools", { loader: true }),
          tool("weather", { deferred: true })
        ],
        params: GenerationParams.make()
      })
    )

    expect(requestBody.tools).toEqual([
      {
        name: "search_tools",
        description: "search_tools description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        }
      },
      {
        name: "weather",
        description: "weather description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        },
        defer_loading: true
      }
    ])
  })

  it("emits an activated tool reference only once across the transcript", () => {
    const modelRequest = activatedRequest("claude-sonnet-4-5")
    const repeated = ModelRequest.make({
      ...modelRequest,
      messages: [
        ...modelRequest.messages,
        Message.tool(ToolResultPart.make({
          toolCallId: "toolu_loader_again",
          content: "Already loaded",
          addedToolNames: ["WEATHER", "weather"]
        }))
      ]
    })
    const encoded = CanonicalJson.stringify(body(repeated))
    expect(encoded.match(/"type":"tool_reference"/g)).toHaveLength(1)
    expect(encoded).toContain("\"content\":\"Already loaded\"")
  })

  it("falls back to the full tool list on unsupported models", () => {
    const request = activatedRequest("claude-haiku")
    const requestBody = body(request)
    expect(requestBody.tools).toHaveLength(2)
    expect(CanonicalJson.stringify(requestBody)).not.toContain("defer_loading")
    expect(CanonicalJson.stringify(requestBody)).not.toContain("tool_reference")
  })

  it("keeps inactive lazy tools out of an unsupported model's initial active list", () => {
    const requestBody = body(
      ModelRequest.make({
        modelId: "claude-haiku",
        system: [],
        messages: [],
        tools: [
          tool("search_tools", { loader: true }),
          tool("weather", { deferred: true })
        ],
        params: GenerationParams.make()
      })
    )

    expect(requestBody.tools?.map((entry) => entry.name)).toEqual(["search_tools"])
    expect(CanonicalJson.stringify(requestBody)).not.toContain("defer_loading")
  })

  it("omits aborted and errored assistant turns and unsigned thinking", () => {
    const request = ModelRequest.make({
      modelId: "claude-sonnet-4-5",
      system: [],
      messages: [
        Message.user("before"),
        Message.assistant("partial", { stopReason: "aborted" }),
        Message.assistant("failed", { stopReason: "error" }),
        Message.assistant([
          ThinkingPart.make({ text: "complete", signature: "signed" }),
          ThinkingPart.make({ text: "incomplete" }),
          { type: "text", text: "answer" }
        ], { stopReason: "stop" })
      ],
      tools: [],
      params: GenerationParams.make()
    })
    const requestBody = body(request)
    expect(requestBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "before" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "complete",
            signature: "signed"
          },
          { type: "text", text: "answer" }
        ]
      }
    ])
  })

  it("delegates deferred support and classifies provider failures", () => {
    expect(AnthropicMessages.protocol.supportsDeferred("claude-opus-4-5")).toBe(true)
    expect(AnthropicMessages.protocol.supportsDeferred("claude-haiku")).toBe(false)
    expect(
      AnthropicMessages.protocol.classifyError(
        429,
        "{\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Slow down\"}}"
      )
    ).toMatchObject({
      code: "rate_limited",
      providerCode: "rate_limit_error",
      httpStatus: 429
    })
  })

  it("classifies an oversized prompt as context_overflow, not as a bad request", () => {
    // Anthropic's own shape: a 400 typed `invalid_request_error` whose message
    // is the only thing that says the request did not fit.
    expect(
      AnthropicMessages.protocol.classifyError(
        400,
        "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 250000 tokens > 200000 maximum\"}}"
      )
    ).toMatchObject({
      code: "context_overflow",
      providerCode: "invalid_request_error",
      httpStatus: 400
    })
    // Any other 400 stays an ordinary bad request; overflow is not a catch-all.
    expect(
      AnthropicMessages.protocol.classifyError(
        400,
        "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"tools.0.name: invalid value\"}}"
      )
    ).toMatchObject({ code: "invalid_request" })
  })
})
