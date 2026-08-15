/** @since 0.1.0 */
import { Option, Schema } from "effect"
import { AssistantMessage, JsonObject, StopReason, ToolCallPart } from "./ModelRequest.ts"

/**
 * Token counts a provider reports for one request. Every field is
 * optional: providers disagree on which counters they expose, and a missing
 * count is not a zero count.
 *
 * @category models
 * @since 0.1.0
 */
export const Usage = Object.assign(
  Schema.Struct({
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheWriteTokens: Schema.optional(Schema.Number),
    totalTokens: Schema.optional(Schema.Number)
  }).annotate({ identifier: "flows/model/Usage" }),
  {
    make: (input: Usage): Usage => input
  }
)

/**
 * The decoded token counts of {@link Usage}.
 *
 * @category models
 * @since 0.1.0
 */
export type Usage = typeof Usage.Type

/**
 * Opens a text part. Its `id` correlates the later deltas and end event
 * that belong to the same part.
 *
 * @category models
 * @since 0.1.0
 */
export const TextStart = Schema.Struct({ type: Schema.Literal("text-start"), id: Schema.String })
/**
 * The decoded form of {@link TextStart}.
 *
 * @category models
 * @since 0.1.0
 */
export type TextStart = typeof TextStart.Type
/**
 * One incremental chunk of a text part's content.
 *
 * @category models
 * @since 0.1.0
 */
export const TextDelta = Schema.Struct({ type: Schema.Literal("text-delta"), id: Schema.String, text: Schema.String })
/**
 * The decoded form of {@link TextDelta}.
 *
 * @category models
 * @since 0.1.0
 */
export type TextDelta = typeof TextDelta.Type
/**
 * Closes the text part opened by the matching {@link TextStart}.
 *
 * @category models
 * @since 0.1.0
 */
export const TextEnd = Schema.Struct({ type: Schema.Literal("text-end"), id: Schema.String })
/**
 * The decoded form of {@link TextEnd}.
 *
 * @category models
 * @since 0.1.0
 */
export type TextEnd = typeof TextEnd.Type
/**
 * Opens a reasoning part. `signature` carries the provider's attestation
 * for the block, which a later request must echo back verbatim.
 *
 * @category models
 * @since 0.1.0
 */
export const ThinkingStart = Schema.Struct({
  type: Schema.Literal("thinking-start"),
  id: Schema.String,
  signature: Schema.optional(Schema.String)
})
/**
 * The decoded form of {@link ThinkingStart}.
 *
 * @category models
 * @since 0.1.0
 */
export type ThinkingStart = typeof ThinkingStart.Type
/**
 * One incremental chunk of a reasoning part's content.
 *
 * @category models
 * @since 0.1.0
 */
export const ThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking-delta"),
  id: Schema.String,
  text: Schema.String
})
/**
 * The decoded form of {@link ThinkingDelta}.
 *
 * @category models
 * @since 0.1.0
 */
export type ThinkingDelta = typeof ThinkingDelta.Type
/**
 * Closes the reasoning part opened by the matching {@link ThinkingStart}.
 *
 * @category models
 * @since 0.1.0
 */
export const ThinkingEnd = Schema.Struct({ type: Schema.Literal("thinking-end"), id: Schema.String })
/**
 * The decoded form of {@link ThinkingEnd}.
 *
 * @category models
 * @since 0.1.0
 */
export type ThinkingEnd = typeof ThinkingEnd.Type
/**
 * Opens a tool call and names the tool. The arguments arrive as deltas.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolCallStart = Schema.Struct({
  type: Schema.Literal("tool-call-start"),
  id: Schema.String,
  name: Schema.String
})
/**
 * The decoded form of {@link ToolCallStart}.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolCallStart = typeof ToolCallStart.Type
/**
 * One incremental chunk of a tool call's JSON argument text.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolCallDelta = Schema.Struct({
  type: Schema.Literal("tool-call-delta"),
  id: Schema.String,
  arguments: Schema.String
})
/**
 * The decoded form of {@link ToolCallDelta}.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolCallDelta = typeof ToolCallDelta.Type
/**
 * Closes a tool call. `arguments` repeats the complete argument text when
 * the provider sends it, which lets a consumer skip reassembling deltas.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolCallEnd = Schema.Struct({
  type: Schema.Literal("tool-call-end"),
  id: Schema.String,
  arguments: Schema.optional(Schema.String)
})
/**
 * The decoded form of {@link ToolCallEnd}.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolCallEnd = typeof ToolCallEnd.Type
/**
 * The result of an executed tool call, as reported by a harness. Tool output
 * is not part of the settled assistant message; it renders alongside the call
 * and feeds the next request's tool message.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  output: Schema.String,
  isError: Schema.optional(Schema.Boolean)
})
/**
 * The decoded form of {@link ToolResult}.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolResult = typeof ToolResult.Type
/**
 * Reports token counts mid-stream. The same counters as {@link Usage},
 * carried as a stream event.
 *
 * @category models
 * @since 0.1.0
 */
export const UsageEvent = Schema.Struct({
  type: Schema.Literal("usage"),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number)
})
/**
 * The decoded form of {@link UsageEvent}.
 *
 * @category models
 * @since 0.1.0
 */
export type UsageEvent = typeof UsageEvent.Type
/**
 * Ends the stream and states why. A stream without one was interrupted.
 *
 * @category models
 * @since 0.1.0
 */
export const Settle = Schema.Struct({
  type: Schema.Literal("settle"),
  stopReason: StopReason,
  responseId: Schema.optional(Schema.String),
  /**
   * Stored provider reasoning items required for replay-safe continuation.
   * See docs/specs/Concepts/Model Layer.md.
   */
  itemIds: Schema.optional(Schema.Array(Schema.String))
})
/**
 * The decoded form of {@link Settle}.
 *
 * @category models
 * @since 0.1.0
 */
export type Settle = typeof Settle.Type

/**
 * Every event a model stream can emit, tagged by `type`, with a constructor
 * per member and {@link settledMessage} attached.
 *
 * @category models
 * @since 0.1.0
 */
export const ModelEvent = Object.assign(
  Schema.Union([
    TextStart,
    TextDelta,
    TextEnd,
    ThinkingStart,
    ThinkingDelta,
    ThinkingEnd,
    ToolCallStart,
    ToolCallDelta,
    ToolCallEnd,
    ToolResult,
    UsageEvent,
    Settle
  ]).pipe(Schema.toTaggedUnion("type")),
  {
    TextStart: TextStart.make,
    TextDelta: TextDelta.make,
    TextEnd: TextEnd.make,
    ThinkingStart: ThinkingStart.make,
    ThinkingDelta: ThinkingDelta.make,
    ThinkingEnd: ThinkingEnd.make,
    ToolCallStart: ToolCallStart.make,
    ToolCallDelta: ToolCallDelta.make,
    ToolCallEnd: ToolCallEnd.make,
    ToolResult: ToolResult.make,
    Usage: (input: Usage): UsageEvent => ({ type: "usage", ...input }),
    Settle: Settle.make,
    settledMessage
  }
)

/**
 * The decoded form of {@link ModelEvent}.
 *
 * @category models
 * @since 0.1.0
 */
export type ModelEvent = typeof ModelEvent.Type

const decodeToolArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObject)
)

/**
 * Folds a stream into the one durable assistant message. No settlement means
 * interruption, which is represented as an aborted message rather than an
 * exception so the transcript remains resumable.
 *
 * @category destructors
 * @since 0.1.0
 */
export function settledMessage(
  events: Iterable<ModelEvent>
): { readonly message: AssistantMessage; readonly usage: Usage } {
  const parts: Array<AssistantMessage["content"][number]> = []
  const indexes = new Map<string, number>()
  let usage: Usage = {}
  let stopReason: StopReason = "aborted"
  let didSettle = false
  let responseId: string | undefined
  let itemIds: ReadonlyArray<string> | undefined

  const part = (id: string, initial: AssistantMessage["content"][number]): number => {
    const existing = indexes.get(id)
    if (existing !== undefined) return existing
    const index = parts.length
    parts.push(initial)
    indexes.set(id, index)
    return index
  }

  for (const event of events) {
    switch (event.type) {
      case "text-start":
        part(event.id, { type: "text", text: "" })
        break
      case "text-delta": {
        const index = part(event.id, { type: "text", text: "" })
        const current = parts[index]
        if (current?.type === "text") parts[index] = { type: "text", text: current.text + event.text }
        break
      }
      case "thinking-start":
        part(event.id, { type: "thinking", text: "", signature: event.signature })
        break
      case "thinking-delta": {
        const index = part(event.id, { type: "thinking", text: "" })
        const current = parts[index]
        if (current?.type === "thinking") parts[index] = { ...current, text: current.text + event.text }
        break
      }
      case "tool-call-start":
        part(event.id, ToolCallPart.make({ id: event.id, name: event.name, arguments: "" }))
        break
      case "tool-call-delta": {
        const index = part(event.id, ToolCallPart.make({ id: event.id, name: "unknown", arguments: "" }))
        const current = parts[index]
        if (current?.type === "tool-call") parts[index] = { ...current, arguments: current.arguments + event.arguments }
        break
      }
      case "tool-call-end": {
        const index = indexes.get(event.id)
        const current = index === undefined ? undefined : parts[index]
        if (index !== undefined && current?.type === "tool-call") {
          const arguments_ = event.arguments ?? current.arguments
          parts[index] = {
            ...current,
            arguments: Option.isSome(decodeToolArguments(arguments_)) ? arguments_ : "{}"
          }
        }
        break
      }
      case "usage": {
        const next = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          reasoningTokens: event.reasoningTokens,
          cachedInputTokens: event.cachedInputTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          totalTokens: event.totalTokens
        }
        usage = {
          ...usage,
          ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))
        }
        break
      }
      case "settle":
        if (!didSettle) {
          stopReason = event.stopReason
          responseId = event.responseId
          itemIds = event.itemIds
          didSettle = true
        }
        break
    }
  }
  return {
    message: new AssistantMessage({
      role: "assistant",
      content: parts,
      stopReason,
      responseId,
      itemIds
    }),
    usage
  }
}
