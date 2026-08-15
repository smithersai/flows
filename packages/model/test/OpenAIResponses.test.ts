import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

const fixture = (name: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> => {
  const source = readFileSync(new URL(`./fixtures/openai/${name}`, import.meta.url), "utf8")
  // Deliberately split this read at irregular boundaries before rebuilding SSE frames.
  const chunks = [source.slice(0, 17), source.slice(17, 61), source.slice(61)]
  const frames: Array<{ readonly event?: string; readonly data: string }> = []
  for (const block of chunks.join("").trim().split("\n\n")) {
    const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7)
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    if (data !== undefined) frames.push(event !== undefined ? { event, data } : { data })
  }
  return frames
}

const streamRequest = Request.ModelRequest.make({
  modelId: "gpt-5.4",
  system: [],
  messages: [],
  tools: [],
  params: Request.GenerationParams.make()
})

const step = (
  state: ReturnType<typeof OpenAIResponses.protocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(data)
  return Effect.runSync(OpenAIResponses.protocol.stream.step(state, event))
}

const body = (modelRequest: Request.ModelRequest, native = true): OpenAIResponses.Body =>
  Effect.runSync(OpenAIResponses.protocol.body.from(modelRequest, { native }))

const replay = (name: string) => {
  let state = OpenAIResponses.protocol.stream.initial(streamRequest)
  const events: Array<Events.ModelEvent> = []
  for (const frame of fixture(name)) {
    const [next, emitted] = step(state, frame.data)
    state = next
    events.push(...emitted)
  }
  events.push(...(OpenAIResponses.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const request = (modelId = "gpt-5.4"): Request.ModelRequest =>
  Request.ModelRequest.make({
    modelId,
    system: [Request.SystemPart.make({ text: "Be exact." })],
    messages: [
      Request.Message.user("Find it"),
      Request.Message.assistant(Request.ToolCallPart.make({ id: "call_loader", name: "search", arguments: "{}" }), {
        stopReason: "tool-calls"
      }),
      Request.Message.tool(
        Request.ToolResultPart.make({ toolCallId: "call_loader", content: "loaded", addedToolNames: ["read_file"] })
      )
    ],
    tools: [
      Request.ToolDefinition.make({ name: "search", description: "search tools", parameters: {}, loader: true }),
      Request.ToolDefinition.make({ name: "read_file", description: "read a file", parameters: {}, deferred: true })
    ],
    params: Request.GenerationParams.make({ maxTokens: 16, temperature: 0, topP: 1 })
  })

describe("OpenAIResponses", () => {
  it("replays text and settles exactly once", () => {
    expect(replay("text.sse")).toEqual([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", text: "Hello" },
      { type: "text-delta", id: "msg_1", text: " world" },
      { type: "text-end", id: "msg_1" },
      { type: "settle", stopReason: "stop", responseId: "resp_text" }
    ])
  })

  it("replays fragmented function arguments", () => {
    expect(replay("tool-call.sse")).toEqual([
      { type: "tool-call-start", id: "call_lookup", name: "lookup" },
      { type: "tool-call-delta", id: "call_lookup", arguments: "{\"query\":" },
      { type: "tool-call-delta", id: "call_lookup", arguments: "\"flows\"}" },
      { type: "tool-call-end", id: "call_lookup", arguments: "{\"query\":\"flows\"}" },
      { type: "settle", stopReason: "tool-calls", responseId: "resp_tools" }
    ])
  })

  it("maps reasoning and completed usage", () => {
    expect(replay("usage.sse")).toEqual([
      { type: "thinking-start", id: "rs_1", signature: "rs_1" },
      { type: "thinking-delta", id: "rs_1", text: "I should count." },
      { type: "thinking-end", id: "rs_1" },
      { type: "usage", inputTokens: 12, outputTokens: 8, cachedInputTokens: 4, reasoningTokens: 3, totalTokens: 20 },
      { type: "settle", stopReason: "stop", responseId: "resp_usage", itemIds: ["rs_1"] }
    ])
  })

  it("replays a reasoning item reference before a combined function-call continuation", () => {
    const events = replay("reasoning-tool-call.sse")
    expect(events).toEqual([
      { type: "tool-call-start", id: "call_combined", name: "read_file" },
      { type: "tool-call-delta", id: "call_combined", arguments: "{\"path\":\"README.md\"}" },
      { type: "tool-call-end", id: "call_combined", arguments: "{\"path\":\"README.md\"}" },
      {
        type: "settle",
        stopReason: "tool-calls",
        responseId: "resp_combined",
        itemIds: ["rs_combined"]
      }
    ])

    const settled = Events.ModelEvent.settledMessage(events).message
    const continuation = Request.ModelRequest.make({
      ...request(),
      messages: [
        settled,
        Request.Message.tool(
          Request.ToolResultPart.make({
            toolCallId: "call_combined",
            content: "contents"
          })
        )
      ]
    })

    expect(body(continuation).input).toEqual([
      { type: "item_reference", id: "rs_combined" },
      {
        type: "function_call",
        call_id: "call_combined",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}"
      },
      {
        type: "function_call_output",
        call_id: "call_combined",
        output: "contents"
      }
    ])
  })

  it("flushes an interrupted tool call without a settle", () => {
    const events = replay("abort-mid-stream.sse")
    expect(events).toEqual([
      { type: "tool-call-start", id: "call_abort", name: "write" },
      { type: "tool-call-delta", id: "call_abort", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call_abort", arguments: "{}" }
    ])
    expect(Events.ModelEvent.settledMessage(events).message).toMatchObject({
      stopReason: "aborted",
      content: [{ type: "tool-call", id: "call_abort", name: "write", arguments: "{}" }]
    })

    const followUp = Request.ModelRequest.make({
      ...request(),
      messages: [Events.ModelEvent.settledMessage(events).message, Request.Message.user("continue")]
    })
    const requestBody = body(followUp)
    expect(CanonicalJson.stringify(requestBody)).not.toContain("call_abort")
    expect(CanonicalJson.stringify(requestBody)).not.toContain("{\\\"path\\\":")
  })

  it("ends a function call once when Responses emits both done events", () => {
    const data = [
      {
        event: "response.output_item.added",
        data:
          "{\"type\":\"response.output_item.added\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call\",\"name\":\"read\",\"arguments\":\"\"}}"
      },
      {
        event: "response.function_call_arguments.delta",
        data: "{\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc\",\"delta\":\"{}\"}"
      },
      {
        event: "response.function_call_arguments.done",
        data: "{\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc\",\"arguments\":\"{}\"}"
      },
      {
        event: "response.output_item.done",
        data:
          "{\"type\":\"response.output_item.done\",\"item_id\":\"fc\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call\",\"name\":\"read\",\"arguments\":\"{}\"}}"
      }
    ]
    let state = OpenAIResponses.protocol.stream.initial(streamRequest)
    const events: Array<Events.ModelEvent> = []
    for (const frame of data) {
      const [next, emitted] = step(state, frame.data)
      state = next
      events.push(...emitted)
    }
    expect(events.filter((event) => event.type === "tool-call-end")).toEqual([
      { type: "tool-call-end", id: "call", arguments: "{}" }
    ])
  })

  it("rejects malformed stream frames as typed provider output errors", () => {
    expect(() => Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)("not-json"))
      .toThrow()
  })

  it("classifies top-level streamed quota and authentication errors", () => {
    for (
      const [data, expected] of [
        [
          "{\"type\":\"error\",\"code\":\"insufficient_quota\",\"message\":\"credits exhausted\"}",
          { code: "quota_exceeded", providerCode: "insufficient_quota" }
        ],
        [
          "{\"type\":\"error\",\"code\":\"invalid_api_key\",\"message\":\"Incorrect API key\"}",
          { code: "authentication", providerCode: "invalid_api_key" }
        ]
      ] as const
    ) {
      const event = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(data)
      const error = Effect.runSync(
        OpenAIResponses.protocol.stream.step(OpenAIResponses.protocol.stream.initial(streamRequest), event).pipe(
          Effect.flip
        )
      )
      expect(error).toMatchObject(expected)
    }
  })

  it("lowers a deterministic native deferred tool-search load point", () => {
    const first = body(request())
    const reordered = request()
    expect(CanonicalJson.stringify(first)).toBe(
      CanonicalJson.stringify(body(reordered))
    )
    const wireBody = first as { readonly input: ReadonlyArray<unknown>; readonly tools: ReadonlyArray<unknown> }
    expect(first.stream).toBe(true)
    expect(wireBody.tools).toEqual([{ type: "function", name: "search", description: "search tools", parameters: {} }])
    expect(wireBody.input.slice(-3)).toEqual([
      { type: "function_call_output", call_id: "call_loader", output: "loaded" },
      {
        type: "tool_search_call",
        call_id: "pi_tool_load_dm2dwtfpjn6h",
        execution: "client",
        status: "completed",
        arguments: { query: "read_file", limit: 1 }
      },
      {
        type: "tool_search_output",
        call_id: "pi_tool_load_dm2dwtfpjn6h",
        execution: "client",
        status: "completed",
        tools: [{
          type: "function",
          name: "read_file",
          description: "read a file",
          parameters: {},
          defer_loading: true
        }]
      }
    ])
  })

  it("keeps an unactivated declared tool out of the initial native request", () => {
    const initial = Request.ModelRequest.make({
      ...request(),
      messages: [Request.Message.user("Find it")]
    })
    const wireBody = body(initial) as {
      readonly input: ReadonlyArray<unknown>
      readonly tools: ReadonlyArray<unknown>
    }

    expect(wireBody.tools).toEqual([
      { type: "function", name: "search", description: "search tools", parameters: {} }
    ])
    expect(CanonicalJson.stringify(wireBody.input)).not.toContain("read_file")
  })

  it("emits one tool-search pair for repeated activation markers", () => {
    const modelRequest = request()
    const repeated = Request.ModelRequest.make({
      ...modelRequest,
      messages: [
        ...modelRequest.messages,
        Request.Message.tool(Request.ToolResultPart.make({
          toolCallId: "call_loader_again",
          content: "already loaded",
          addedToolNames: ["READ_FILE", "read_file"]
        }))
      ]
    })
    const input = body(repeated).input as ReadonlyArray<{ readonly type?: string }>
    expect(input.filter((item) => item.type === "tool_search_call")).toHaveLength(1)
    expect(input.filter((item) => item.type === "tool_search_output")).toHaveLength(1)
  })

  it("uses the Responses reasoning-effort wire enum and always requests streaming", () => {
    const requestBody = body(
      Request.ModelRequest.make({
        ...request(),
        params: Request.GenerationParams.make({
          thinkingBudget: 1_024,
          reasoningEffort: "high"
        })
      })
    )
    expect(requestBody).toMatchObject({ reasoning: { effort: "high" }, stream: true })
    expect(CanonicalJson.stringify(requestBody)).not.toContain("1024")
  })

  it("falls back to the complete active list and omits incomplete history", () => {
    const legacy = body(request("gpt-4o")) as {
      readonly tools: ReadonlyArray<unknown>
      readonly input: ReadonlyArray<unknown>
    }
    expect(legacy.tools).toHaveLength(2)
    expect(legacy.input.some((item) => (item as { readonly type?: string }).type === "tool_search_call")).toBe(false)
    const aborted = Request.ModelRequest.make({
      ...request(),
      messages: [Request.Message.assistant("partial", { stopReason: "aborted" }), Request.Message.user("continue")]
    })
    expect(CanonicalJson.stringify(body(aborted, false))).not.toContain(
      "partial"
    )
  })

  it("keeps inactive lazy tools out of an unsupported model's initial active list", () => {
    const initial = Request.ModelRequest.make({
      ...request("gpt-4o"),
      messages: [Request.Message.user("Find it")]
    })
    const legacy = body(initial) as { readonly tools: ReadonlyArray<{ readonly name: string }> }

    expect(legacy.tools.map((entry) => entry.name)).toEqual(["search"])
    expect(CanonicalJson.stringify(legacy)).not.toContain("defer_loading")
  })
})
