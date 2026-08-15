/**
 * @since 0.1.0
 *
 * The serializable, credential-free declaration of one model call.
 */
import { Schema } from "effect"

/**
 * A plain JSON object. Unlike `Schema.Record`, decoding starts from
 * `Schema.Json`, so class instances such as `Date` and `Map` cannot be
 * accepted as empty records.
 *
 * @category schemas
 * @since 0.1.0
 */
export const JsonObject = Schema.Json.pipe(
  Schema.refine(
    (value): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value),
    { expected: "a JSON object" }
  )
)

/** @category models @since 0.1.0 */
export type JsonObject = typeof JsonObject.Type

/** @category models @since 0.1.0 */
export const StopReason = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "aborted",
  "unknown"
])

/** @category models @since 0.1.0 */
export type StopReason = typeof StopReason.Type

/** @category models @since 0.1.0 */
export const SystemPart = Object.assign(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }).annotate({
    identifier: "flows/model/SystemPart"
  }),
  { make: (input: { readonly text: string }): SystemPart => ({ type: "text", text: input.text }) }
)

/** @category models @since 0.1.0 */
export type SystemPart = typeof SystemPart.Type

/** @category models @since 0.1.0 */
export const TextPart = Object.assign(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }).annotate({ identifier: "flows/model/TextPart" }),
  { make: (input: { readonly text: string }): TextPart => ({ type: "text", text: input.text }) }
)

/** @category models @since 0.1.0 */
export type TextPart = typeof TextPart.Type

/** @category models @since 0.1.0 */
export const ThinkingPart = Object.assign(
  Schema.Struct({
    type: Schema.Literal("thinking"),
    text: Schema.String,
    signature: Schema.optional(Schema.String)
  }).annotate({ identifier: "flows/model/ThinkingPart" }),
  {
    make: (input: { readonly text: string; readonly signature?: string | undefined }): ThinkingPart => ({
      type: "thinking",
      text: input.text,
      signature: input.signature
    })
  }
)

/** @category models @since 0.1.0 */
export type ThinkingPart = typeof ThinkingPart.Type

/** @category models @since 0.1.0 */
export const ToolCallPart = Object.assign(
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.String
  }).annotate({ identifier: "flows/model/ToolCallPart" }),
  {
    make: (input: { readonly id: string; readonly name: string; readonly arguments: string }): ToolCallPart => ({
      type: "tool-call",
      ...input
    })
  }
)

/** @category models @since 0.1.0 */
export type ToolCallPart = typeof ToolCallPart.Type

/** @category models @since 0.1.0 */
export const ToolResultPart = Object.assign(
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    toolCallId: Schema.String,
    content: Schema.String,
    addedToolNames: Schema.Array(Schema.String)
  }).annotate({ identifier: "flows/model/ToolResultPart" }),
  {
    make: (input: {
      readonly toolCallId: string
      readonly content: string
      readonly addedToolNames?: ReadonlyArray<string> | undefined
    }): ToolResultPart => ({
      type: "tool-result",
      toolCallId: input.toolCallId,
      content: input.content,
      addedToolNames: input.addedToolNames ?? []
    })
  }
)

/** @category models @since 0.1.0 */
export type ToolResultPart = typeof ToolResultPart.Type

/** @category models @since 0.1.0 */
export const ContentPart = Schema.Union([TextPart, ThinkingPart, ToolCallPart, ToolResultPart]).pipe(
  Schema.toTaggedUnion("type")
)

/** @category models @since 0.1.0 */
export type ContentPart = typeof ContentPart.Type

/** @category models @since 0.1.0 */
export const AssistantContentPart = Schema.Union([TextPart, ThinkingPart, ToolCallPart]).pipe(
  Schema.toTaggedUnion("type")
)

/** @category models @since 0.1.0 */
export type AssistantContentPart = typeof AssistantContentPart.Type

/** @category models @since 0.1.0 */
export class UserMessage extends Schema.Class<UserMessage>("flows/model/UserMessage")({
  role: Schema.Literal("user"),
  content: Schema.Array(TextPart)
}) {}

/** @category models @since 0.1.0 */
export class AssistantMessage extends Schema.Class<AssistantMessage>("flows/model/AssistantMessage")({
  role: Schema.Literal("assistant"),
  content: Schema.Array(AssistantContentPart),
  stopReason: StopReason,
  responseId: Schema.optional(Schema.String),
  /**
   * Stored OpenAI reasoning item ids that must be replayed as item references.
   * See docs/specs/Concepts/Model Layer.md, "Flue adoption and deviation".
   */
  itemIds: Schema.optional(Schema.Array(Schema.String))
}) {}

/** @category models @since 0.1.0 */
export class ToolMessage extends Schema.Class<ToolMessage>("flows/model/ToolMessage")({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart)
}) {}

/** @category models @since 0.1.0 */
export const Message = Object.assign(
  Schema.Union([UserMessage, AssistantMessage, ToolMessage]).pipe(Schema.toTaggedUnion("role")),
  {
    make: (message: Message): Message => message,
    user: (content: string | TextPart | ReadonlyArray<TextPart>): UserMessage =>
      new UserMessage({ role: "user", content: userContentParts(content) }),
    assistant: (
      content: string | AssistantContentPart | ReadonlyArray<AssistantContentPart>,
      options: {
        readonly stopReason?: StopReason | undefined
        readonly responseId?: string | undefined
        readonly itemIds?: ReadonlyArray<string> | undefined
      } = {}
    ): AssistantMessage =>
      new AssistantMessage({
        role: "assistant",
        content: contentParts(content),
        stopReason: options.stopReason ?? "unknown",
        responseId: options.responseId,
        itemIds: options.itemIds
      }),
    tool: (content: ToolResultPart | ReadonlyArray<ToolResultPart>): ToolMessage =>
      new ToolMessage({ role: "tool", content: "type" in content ? [content] : content })
  }
)

/** @category models @since 0.1.0 */
export type Message = typeof Message.Type

const userContentParts = (content: string | TextPart | ReadonlyArray<TextPart>): ReadonlyArray<TextPart> =>
  typeof content === "string" ? [TextPart.make({ text: content })] : "type" in content ? [content] : content

const contentParts = (
  content: string | AssistantContentPart | ReadonlyArray<AssistantContentPart>
): ReadonlyArray<AssistantContentPart> =>
  typeof content === "string" ? [TextPart.make({ text: content })] : "type" in content ? [content] : content

/**
 * A provider-neutral tool declaration. `parameters` is a JSON Schema object.
 *
 * @category models
 * @since 0.1.0
 */
export class ToolDefinition extends Schema.Class<ToolDefinition>("flows/model/ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
  /**
   * A lazy tool is wire metadata only. Per
   * docs/specs/Research/Pi Reference Findings 2026-07-27.md §4 it may never
   * add prompt text, snippets, or guidelines.
   */
  deferred: Schema.optional(Schema.Boolean),
  loader: Schema.optional(Schema.Boolean)
}) {
  /** @category constructors @since 0.1.0 */
  static override make(input: ToolDefinition | ConstructorParameters<typeof ToolDefinition>[0]): ToolDefinition {
    return input instanceof ToolDefinition ? input : new ToolDefinition(input)
  }
}

/** @category models @since 0.1.0 */
export const ReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
])

/** @category models @since 0.1.0 */
export type ReasoningEffort = typeof ReasoningEffort.Type

/** @category models @since 0.1.0 */
export class GenerationParams extends Schema.Class<GenerationParams>("flows/model/GenerationParams")({
  maxTokens: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
  topK: Schema.optional(Schema.Finite),
  stopSequences: Schema.optional(Schema.Array(Schema.String)),
  thinkingBudget: Schema.optional(Schema.Finite),
  reasoningEffort: Schema.optional(ReasoningEffort)
}) {
  /** @category constructors @since 0.1.0 */
  static override make(
    input: GenerationParams | ConstructorParameters<typeof GenerationParams>[0] = {}
  ): GenerationParams {
    return input instanceof GenerationParams ? input : new GenerationParams(input)
  }
}

/**
 * How the provider may use the declared tools.
 *
 * Only `none` is modelled, because it is the one value the harness declares: a
 * cell-first frame and a legacy landing frame both forbid tool use. It is a
 * declared property of the request — part of the sealed step's key material and
 * readable by any adapter — rather than a wire field. The built-in protocol
 * encoders express the same thing by omitting `tools` altogether, which is what
 * both provider APIs require; neither accepts a tool choice without tools.
 *
 * @category models
 * @since 0.1.0
 */
export const ToolChoice = Schema.Literal("none")

/**
 * How the provider may use the declared tools.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolChoice = typeof ToolChoice.Type

/**
 * The declaration order below is load-bearing: it is the stable step-key
 * serialization order for a sealed model step.
 *
 * @category models
 * @since 0.1.0
 */
export class ModelRequest extends Schema.Class<ModelRequest>("flows/model/ModelRequest")({
  modelId: Schema.String,
  system: Schema.Array(SystemPart),
  messages: Schema.Array(Message),
  tools: Schema.Array(ToolDefinition),
  params: GenerationParams,
  toolChoice: Schema.optional(ToolChoice)
}) {
  /** @category constructors @since 0.1.0 */
  static override make(input: ModelRequest | ConstructorParameters<typeof ModelRequest>[0]): ModelRequest {
    return input instanceof ModelRequest ? input : new ModelRequest(input)
  }
}
