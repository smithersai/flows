import { Model, ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import * as AgentEvent from "../../src/AgentEvent.ts"
import * as ContextWindow from "../../src/ContextWindow.ts"
import * as Elaborate from "../../src/Elaborate.ts"
import * as EngineLike from "../../src/EngineLike.ts"
import { HarnessError } from "../../src/HarnessError.ts"
import * as Plan from "../../src/Plan.ts"
import * as Steering from "../../src/Steering.ts"
import * as Turn from "../../src/Turn.ts"

/** @category fixtures @since 0.1.0 */
export type Variant = "complete" | "provider-error" | "tool-failure"

/** @category fixtures @since 0.1.0 */
export interface RecordedStep {
  readonly events: ReadonlyArray<ModelEvent.ModelEvent>
  readonly expectedToolNames: ReadonlyArray<string>
  readonly expectedToolResultIds: ReadonlyArray<string>
  readonly providerError?: ModelError.ModelError | undefined
}

const text = (
  id: string,
  parts: ReadonlyArray<string>
): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ...parts.map((part) => ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: part })),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id })
]

const call = (
  id: string,
  name: string,
  arguments_: string
): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id, name }),
  ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id, arguments: arguments_ }),
  ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id })
]

const completeTurnOneEvents: ReadonlyArray<ModelEvent.ModelEvent> = Object.freeze([
  ...text("opening", ["I will inspect both values", "."]),
  ...call("call-alpha", "alpha", "{\"value\":\"one\"}"),
  ...call("call-beta", "beta", "{\"value\":\"two\"}"),
  ModelEvent.ModelEvent.Usage({ inputTokens: 20, outputTokens: 14 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls", responseId: "response-1" })
])

const completeTurnTwoEvents: ReadonlyArray<ModelEvent.ModelEvent> = Object.freeze([
  ...text("answer", ["Both values are recorded."]),
  ModelEvent.ModelEvent.Usage({ inputTokens: 48, outputTokens: 7 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop", responseId: "response-2" })
])

const providerErrorEvents: ReadonlyArray<ModelEvent.ModelEvent> = Object.freeze(
  text("partial", ["The provider started the answer", "."])
)

const providerError = new ModelError.ModelError({
  code: "provider_internal",
  message: "Recorded provider failure",
  providerCode: "fixture_mid_stream",
  requestId: "request-error"
})

/** The immutable successful two-turn provider script. @category fixtures @since 0.1.0 */
export const recordedScript: ReadonlyArray<RecordedStep> = Object.freeze([
  Object.freeze({
    events: completeTurnOneEvents,
    expectedToolNames: Object.freeze(["alpha", "beta"]),
    expectedToolResultIds: Object.freeze([])
  }),
  Object.freeze({
    events: completeTurnTwoEvents,
    expectedToolNames: Object.freeze(["alpha", "beta"]),
    expectedToolResultIds: Object.freeze(["call-alpha", "call-beta"])
  })
])

/** The immutable provider-error variant of the first recorded turn. @category fixtures @since 0.1.0 */
export const providerErrorScript: ReadonlyArray<RecordedStep> = Object.freeze([
  Object.freeze({
    events: providerErrorEvents,
    expectedToolNames: Object.freeze(["alpha", "beta"]),
    expectedToolResultIds: Object.freeze([]),
    providerError
  })
])

const alpha = ModelRequest.ToolDefinition.make({
  name: "alpha",
  description: "Read the first recorded value.",
  parameters: { type: "object", properties: { value: { type: "string" } } }
})

const beta = ModelRequest.ToolDefinition.make({
  name: "beta",
  description: "Read the second recorded value.",
  parameters: { type: "object", properties: { value: { type: "string" } } }
})

/** The tool definitions used by the recorded session. @category fixtures @since 0.1.0 */
export const toolDefinitions: ReadonlyArray<ModelRequest.ToolDefinition> = Object.freeze([alpha, beta])

/** The elaboration catalog used by the recorded session. @category fixtures @since 0.1.0 */
export const catalog: Elaborate.Catalog = {
  tools: {
    alpha: {
      flowName: "alpha",
      input: Schema.Struct({ value: Schema.String }),
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none()
    },
    beta: {
      flowName: "beta",
      input: Schema.Struct({ value: Schema.String }),
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none()
    }
  }
}

const context = (): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: "recorded-model",
    segments: [
      {
        kind: "system",
        zone: "prefix",
        content: [ModelRequest.SystemPart.make({ text: "Recorded session" })]
      },
      {
        kind: "tools",
        zone: "prefix",
        content: toolDefinitions
      },
      {
        kind: "transcript",
        zone: "tail",
        content: [ModelRequest.Message.user("Inspect the recorded values.")]
      }
    ],
    activeTools: toolDefinitions.map((definition) => definition.name)
  })

/** Constructs the initial turn input for a recorded session. @category constructors @since 0.1.0 */
export const input = (): Turn.Input => ({
  state: Turn.make({
    seat: "sdk:recorded-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["model:recorded"],
    capabilityEnvelope: [],
    placement: Option.none(),
    contextWindow: context()
  }),
  catalog
})

const expectedError = (index: number, message: string): ModelError.ModelError =>
  new ModelError.ModelError({
    code: "invalid_provider_output",
    message: `Recorded session request ${index} ${message}`
  })

const requestMatches = (request: ModelRequest.ModelRequest, step: RecordedStep): boolean => {
  const names = request.tools.map((tool) => tool.name)
  if (JSON.stringify(names) !== JSON.stringify(step.expectedToolNames)) return false
  const resultIds = request.messages.flatMap((message) =>
    message.role === "tool" ? message.content.map((result) => result.toolCallId) : []
  )
  return JSON.stringify(resultIds) === JSON.stringify(step.expectedToolResultIds)
}

/** Recorded requests and events exposed by one fixture instance. @category fixtures @since 0.1.0 */
export interface RecordedSession {
  readonly model: Model.Model
  readonly modelLayer: Layer.Layer<Model.Model>
  readonly engine: EngineLike.EngineLike
  readonly engineLayer: Layer.Layer<EngineLike.EngineLike>
  readonly run: (turn: Turn.Input) => Effect.Effect<ReadonlyArray<AgentEvent.AgentEvent>, HarnessError>
  readonly sealedRequests: ReadonlyArray<ModelRequest.ModelRequest>
  readonly emittedEvents: ReadonlyArray<AgentEvent.AgentEvent>
  readonly unscriptedRequests: ReadonlyArray<ModelRequest.ModelRequest>
  readonly exhausted: () => boolean
}

/** Constructs a network-free, fail-fast multi-turn recorded session. @category constructors @since 0.1.0 */
export const make = (variant: Variant = "complete"): RecordedSession => {
  const script = variant === "provider-error" ? providerErrorScript : recordedScript
  const requests: Array<ModelRequest.ModelRequest> = []
  const emitted: Array<AgentEvent.AgentEvent> = []
  const unscripted: Array<ModelRequest.ModelRequest> = []
  let modelIndex = 0
  let spliceIndex = 0

  const model = Model.make({
    stream: (request) => {
      requests.push(request)
      const index = modelIndex++
      const step = script[index]
      if (step === undefined || !requestMatches(request, step)) {
        unscripted.push(request)
        return Stream.fail(
          expectedError(index, step === undefined ? "was not scripted" : "did not match its script")
        )
      }
      const events = Stream.fromIterable(step.events)
      return step.providerError === undefined
        ? events
        : Stream.concat(events, Stream.fail(step.providerError))
    }
  })

  const engine = EngineLike.make({
    sealStep: ({ request }) => model.stream(request),
    splice: (batch) => {
      const expected = ["call-alpha", "call-beta"]
      if (
        spliceIndex++ !== 0 || JSON.stringify(batch.children.map((child) => child.callId)) !== JSON.stringify(expected)
      ) {
        return Stream.fail(
          new HarnessError({
            code: "engine_failed",
            message: "Recorded session received an unscripted child batch"
          })
        )
      }
      return Stream.fromIterable([
        new Plan.ChildProgress({ callId: "call-alpha", message: "started" }),
        new Plan.ChildProgress({ callId: "call-beta", message: "started" }),
        new Plan.ChildProgress({ callId: "call-beta", message: "completed first" }),
        new Plan.ChildSettled({
          result: new Plan.ChildResult({
            callId: "call-beta",
            outcome: "success",
            result: ModelRequest.ToolResultPart.make({
              toolCallId: "call-beta",
              content: "beta result"
            })
          })
        }),
        new Plan.ChildProgress({ callId: "call-alpha", message: "completed second" }),
        new Plan.ChildSettled({
          result: new Plan.ChildResult({
            callId: "call-alpha",
            outcome: variant === "tool-failure" ? "error" : "success",
            result: ModelRequest.ToolResultPart.make({
              toolCallId: "call-alpha",
              content: variant === "tool-failure" ? "alpha failed locally" : "alpha result"
            })
          })
        })
      ])
    },
    call: () => Effect.die("this fixture drives the tool-call path, not cells"),
    record: (boundary) => boundary.execute,
    suspend: (reason) =>
      Effect.fail(
        new HarnessError({
          code: "suspended",
          message: reason.message
        })
      )
  })
  const modelLayer = Model.layer(model)
  const engineLayer = EngineLike.layer(engine)

  const run = (turn: Turn.Input): Effect.Effect<ReadonlyArray<AgentEvent.AgentEvent>, HarnessError> =>
    Turn.run(turn).pipe(
      Stream.tap((event) => Effect.sync(() => emitted.push(event))),
      Stream.runCollect,
      Effect.provide(engineLayer),
      Effect.provide(Steering.layerNoop()),
      Effect.map((events) => Array.from(events))
    )

  const session: RecordedSession = {
    model,
    modelLayer,
    engine,
    engineLayer,
    run,
    get sealedRequests() {
      return [...requests]
    },
    get emittedEvents() {
      return [...emitted]
    },
    get unscriptedRequests() {
      return [...unscripted]
    },
    exhausted: () =>
      modelIndex === script.length && (variant === "provider-error" || spliceIndex === 1) &&
      unscripted.length === 0
  }
  return session
}
