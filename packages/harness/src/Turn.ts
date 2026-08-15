/**
 * Re-enterable execution of one built-in harness turn at a time.
 *
 * Governing design: `docs/specs/Specs/Harness.md`.
 *
 * @since 0.1.0
 */
import { Effects, type KeyMaterial, Placement } from "@smthrs/core"
import { Capability, Permission } from "@smthrs/kernel-next"
import { type Model, type ModelError, ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Cause, Deferred, Effect, Option, Result, Schema, Semaphore, Stream } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import * as Compaction from "./Compaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import * as Elaborate from "./Elaborate.ts"
import * as EngineLike from "./EngineLike.ts"
import { HarnessError } from "./HarnessError.ts"
import * as Plan from "./Plan.ts"
import * as Steering from "./Steering.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Default number of provider frames available to one admitted task.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultMaxFrames = 100

const MaxFrames = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(defaultMaxFrames)),
  Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxFrames))
)

const ContextWindowTokens = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(0)),
  Schema.withDecodingDefaultKey(Effect.succeed(0))
)

const maxFramesPrompt = `CRITICAL - MAXIMUM FRAMES REACHED

The maximum number of frames allowed for this task has been reached. Tools are disabled until the next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls
2. Summarize the work completed so far
3. List remaining work and recommended next steps

State that the maximum frame budget has been reached. This instruction overrides requests to use tools.`

/**
 * Serializable state at the boundary between engine-owned turn frames.
 *
 * Runtime services and the elaboration catalog are deliberately absent. A
 * caller can re-enter this state against the same journal prefix and receive
 * the identical next sealed-step request.
 *
 * @category models
 * @since 0.1.0
 */
export class TurnState extends Schema.Class<TurnState>("flows/harness/Turn/TurnState")({
  frame: NonNegativeSafeInt,
  maxFrames: MaxFrames,
  contextWindowTokens: ContextWindowTokens,
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  layers: Schema.Array(Schema.String),
  capabilityEnvelope: Schema.Array(Capability.CapabilityPattern),
  placement: Schema.Option(Descriptor.Placement),
  contextWindow: ContextWindow.ContextWindow
}) {}

/**
 * Runtime declarations used to interpret serializable turn state.
 *
 * @category models
 * @since 0.1.0
 */
export interface Input {
  readonly state: TurnState
  readonly catalog: Elaborate.Catalog
}

/**
 * Constructs a serializable initial turn state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: {
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly layers: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly placement: Option.Option<Descriptor.Placement>
  readonly contextWindow: ContextWindow.ContextWindow
  readonly frame?: number | undefined
  readonly maxFrames?: number | undefined
  readonly contextWindowTokens?: number | undefined
}): TurnState =>
  new TurnState({
    frame: options.frame ?? 0,
    maxFrames: options.maxFrames ?? defaultMaxFrames,
    contextWindowTokens: options.contextWindowTokens ?? 0,
    seat: options.seat,
    modelParams: options.modelParams,
    layers: options.layers,
    capabilityEnvelope: options.capabilityEnvelope,
    placement: options.placement,
    contextWindow: options.contextWindow
  })

type UnfoldState =
  | { readonly _tag: "Turn"; readonly state: TurnState; readonly recovered: boolean }
  | { readonly _tag: "Await"; readonly next: Deferred.Deferred<UnfoldState> }
  | { readonly _tag: "Compact"; readonly state: TurnState; readonly recovered: boolean }
  | { readonly _tag: "Fail"; readonly error: HarnessError }
  | { readonly _tag: "Suspend"; readonly reason: EngineLike.SuspendReason }
  | { readonly _tag: "Done" }

interface Settlement {
  readonly message: ModelRequest.AssistantMessage
  readonly usage: ModelEvent.Usage
}

const eventType = {
  aborted: "flows.harness.aborted.v1",
  childProgress: "flows.harness.child-progress.v1",
  childResult: "flows.harness.child-result.v1",
  elaborated: "flows.harness.elaborated.v1",
  modelDelta: "flows.harness.model-delta.v1",
  modelSettled: "flows.harness.model-settled.v1",
  permissionRequired: "flows.harness.permission-required.v1",
  resolved: "flows.harness.resolved.v1",
  steeringDrained: "flows.harness.steering-drained.v1",
  turnClosed: "flows.harness.turn-closed.v1",
  turnOpened: "flows.harness.turn-opened.v1"
} as const

const failure = (code: HarnessError["code"], message: string, cause?: unknown): HarnessError =>
  new HarnessError({ code, message, cause })

const modelIdFromSeat = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

const isLandingFrame = (state: TurnState): boolean => state.maxFrames > 0 && state.frame >= state.maxFrames - 1

const isLandingSegment = (segment: ContextWindow.Segment): boolean =>
  segment.kind === "steering" &&
  segment.content.length === 1 &&
  segment.content[0] instanceof ModelRequest.AssistantMessage &&
  segment.content[0].content.length === 1 &&
  segment.content[0].content[0]?.type === "text" &&
  segment.content[0].content[0].text === maxFramesPrompt

const withLanding = (state: TurnState): TurnState => {
  if (!isLandingFrame(state) || state.contextWindow.segments.some(isLandingSegment)) return state
  return new TurnState({
    frame: state.frame,
    maxFrames: state.maxFrames,
    contextWindowTokens: state.contextWindowTokens,
    seat: state.seat,
    modelParams: state.modelParams,
    layers: state.layers,
    capabilityEnvelope: state.capabilityEnvelope,
    placement: state.placement,
    contextWindow: ContextWindow.make({
      modelId: state.contextWindow.modelId,
      segments: [
        ...state.contextWindow.segments,
        ContextWindow.makeSegment({
          kind: "steering",
          zone: "tail",
          content: [ModelRequest.Message.assistant(maxFramesPrompt)]
        })
      ],
      activeTools: state.contextWindow.activeTools,
      replaced: state.contextWindow.replaced
    })
  })
}

const withoutLanding = (context: ContextWindow.ContextWindow): ContextWindow.ContextWindow =>
  context.segments.some(isLandingSegment)
    ? ContextWindow.make({
      modelId: context.modelId,
      segments: context.segments.filter((segment) => !isLandingSegment(segment)),
      activeTools: context.activeTools,
      replaced: context.replaced
    })
    : context

const requestFrom = Effect.fn("Turn.requestFrom")(function*(
  state: TurnState
) {
  let rendered: ModelRequest.ModelRequest
  try {
    rendered = ContextWindow.render(state.contextWindow)
  } catch (cause) {
    return yield* new HarnessError({
      code: "render_failed",
      message: "Unable to render the context window",
      cause
    })
  }
  const landing = isLandingFrame(state)
  return ModelRequest.ModelRequest.make({
    modelId: modelIdFromSeat(state.seat),
    system: rendered.system,
    messages: rendered.messages,
    tools: landing ? [] : rendered.tools,
    params: state.modelParams,
    toolChoice: landing ? "none" : undefined
  })
})

const permissionRequired = (error: unknown): Permission.PermissionRequired | undefined => {
  if (error instanceof Permission.PermissionRequired) return error
  if (error instanceof HarnessError && error.cause instanceof Permission.PermissionRequired) return error.cause
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Permission.PermissionRequired)(
      error instanceof HarnessError ? error.cause : error
    )
  )
}

const assistantSettlement = (
  events: ReadonlyArray<ModelEvent.ModelEvent>
): Settlement | undefined => {
  if (!events.some((event) => event.type === "settle")) return undefined
  const settled = ModelEvent.ModelEvent.settledMessage(events)
  return {
    message: settled.message,
    usage: settled.usage
  }
}

const partialSettlement = (
  events: ReadonlyArray<ModelEvent.ModelEvent>,
  stopReason: "aborted" | "error"
): Settlement | undefined => {
  const settled = ModelEvent.ModelEvent.settledMessage([
    ...events,
    ModelEvent.ModelEvent.Settle({
      type: "settle",
      stopReason
    })
  ])
  if (settled.message.content.length === 0) return undefined
  return {
    message: new ModelRequest.AssistantMessage({
      role: "assistant",
      content: settled.message.content.map((part) =>
        part.type === "thinking"
          ? ModelRequest.ThinkingPart.make({ text: part.text })
          : part
      ),
      stopReason
    }),
    usage: settled.usage
  }
}

const modelSettledEvent = (settlement: Settlement): AgentEvent.ModelSettled =>
  new AgentEvent.ModelSettled({
    eventType: eventType.modelSettled,
    message: settlement.message,
    usage: settlement.usage
  })

const abortedToolResult = (callId: string, reason = "Operation aborted"): Plan.ChildResult =>
  new Plan.ChildResult({
    callId,
    outcome: "aborted",
    result: ModelRequest.ToolResultPart.make({
      toolCallId: callId,
      content: reason
    })
  })

const missingToolResult = (callId: string): Plan.ChildResult =>
  new Plan.ChildResult({
    callId,
    outcome: "error",
    result: ModelRequest.ToolResultPart.make({
      toolCallId: callId,
      content: "The engine did not return a result for this call; re-issue the call."
    })
  })

const errorToolResult = (result: ModelRequest.ToolResultPart): Plan.ChildResult =>
  new Plan.ChildResult({
    callId: result.toolCallId,
    outcome: "error",
    result
  })

const orderedResults = (
  orderedCallIds: ReadonlyArray<string>,
  errors: ReadonlyArray<ModelRequest.ToolResultPart>,
  children: ReadonlyArray<Plan.ChildResult>
): ReadonlyArray<Plan.ChildResult> => {
  const byCallId = new Map<string, Plan.ChildResult>()
  for (const result of errors) byCallId.set(result.toolCallId, errorToolResult(result))
  for (const result of children) {
    byCallId.set(result.callId, result)
  }
  return orderedCallIds.map((callId) => {
    const result = byCallId.get(callId)
    return result ?? missingToolResult(callId)
  })
}

const appendSteering = (
  context: ContextWindow.ContextWindow,
  messages: ReadonlyArray<ModelRequest.Message>
): ContextWindow.ContextWindow =>
  messages.length === 0
    ? context
    : ContextWindow.make({
      modelId: context.modelId,
      segments: [
        ...context.segments,
        ContextWindow.makeSegment({
          kind: "steering",
          zone: "tail",
          content: messages
        })
      ],
      activeTools: context.activeTools,
      replaced: context.replaced
    })

const applySeatChanges = (
  state: TurnState,
  changes: ReadonlyArray<Steering.SeatChange | Steering.ThinkingChange>
): Pick<TurnState, "seat" | "modelParams"> => {
  let seat = state.seat
  let modelParams = state.modelParams
  for (const change of changes) {
    if (change._tag === "SeatChange") {
      seat = change.seat
    } else {
      modelParams = ModelRequest.GenerationParams.make({
        maxTokens: modelParams.maxTokens,
        temperature: modelParams.temperature,
        topP: modelParams.topP,
        topK: modelParams.topK,
        stopSequences: modelParams.stopSequences,
        thinkingBudget: modelParams.thinkingBudget,
        reasoningEffort: change.thinking
      })
    }
  }
  return { seat, modelParams }
}

const placementFrom = (state: TurnState): Placement.Placement | undefined =>
  Option.match(state.placement, {
    onNone: () => undefined,
    onSome: (value) => {
      switch (value) {
        case "client":
          return Placement.client()
        case "local":
          return Placement.local()
        case "remote":
          return Placement.remote()
        case "sandbox":
          return Placement.sandbox()
      }
    }
  })

const keyMaterialFrom = (
  state: TurnState,
  request: ModelRequest.ModelRequest
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v1",
  kind: "sealed",
  body: {
    _tag: "ModelCall",
    request
  },
  inputs: [{
    _tag: "Literal",
    value: { contextDigest: state.contextWindow.digest }
  }],
  layers: [...new Set(state.layers)].sort(),
  capabilities: [...new Set(state.capabilityEnvelope.map(Capability.format))].sort(),
  effects: Effects.make({
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }),
  placement: placementFrom(state)
})

type WithPublication = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, R>

const emit = (
  withPublication: WithPublication,
  event: AgentEvent.AgentEvent
): Stream.Stream<AgentEvent.AgentEvent> => Stream.fromEffect(withPublication(Effect.succeed(event)))

const emitAll = (
  withPublication: WithPublication,
  events: ReadonlyArray<AgentEvent.AgentEvent>
): Stream.Stream<AgentEvent.AgentEvent> =>
  Stream.fromIterable(events).pipe(
    Stream.mapEffect((event) => withPublication(Effect.succeed(event)))
  )

const complete = (
  deferred: Deferred.Deferred<UnfoldState>,
  next: UnfoldState
): Stream.Stream<never> => Stream.fromEffect(Deferred.succeed(deferred, next)).pipe(Stream.drain)

const abortedEvents = (
  reason: string,
  stopReason: ModelRequest.StopReason = "aborted"
): ReadonlyArray<AgentEvent.AgentEvent> => [
  new AgentEvent.Aborted({
    eventType: eventType.aborted,
    reason
  }),
  new AgentEvent.TurnClosed({
    eventType: eventType.turnClosed,
    stopReason,
    outcome: "aborted"
  })
]

const abort = (
  withPublication: WithPublication,
  reason: string,
  stopReason: ModelRequest.StopReason = "aborted",
  leading: ReadonlyArray<AgentEvent.AgentEvent> = []
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> =>
  Stream.concat(
    emitAll(withPublication, [
      ...leading,
      ...abortedEvents(reason, stopReason)
    ]),
    Stream.fail(failure("aborted", reason))
  )

type FailureClassification =
  | { readonly _tag: "ContextOverflow"; readonly error: ModelError.ModelError }
  | { readonly _tag: "Other"; readonly error: unknown }

/**
 * Whether a failed model step overflowed the context window.
 *
 * The decision is the provider adapter's typed `context_overflow` code and
 * nothing else. Re-deriving it here from `providerCode` and `message` made
 * recovery depend on prose no provider promises to keep stable, and it silently
 * stopped working for any provider whose wording the harness had not seen.
 */
const isContextOverflow = (error: ModelError.ModelError): boolean => error.code === "context_overflow"

const classifyFailure = (
  error: Model.ModelFailure | HarnessError | undefined
): Effect.Effect<FailureClassification> => {
  if (error === undefined) return Effect.succeed({ _tag: "Other", error })
  return Effect.fail(error).pipe(
    Effect.catchTag("flows/model/ModelError", (modelError) =>
      Effect.succeed<FailureClassification>(
        isContextOverflow(modelError)
          ? { _tag: "ContextOverflow", error: modelError }
          : { _tag: "Other", error: modelError }
      )),
    Effect.catch((other) => Effect.succeed<FailureClassification>({ _tag: "Other", error: other }))
  )
}

const modelFailure = (
  state: TurnState,
  recovered: boolean,
  modelEvents: ReadonlyArray<ModelEvent.ModelEvent>,
  withPublication: WithPublication,
  next: Deferred.Deferred<UnfoldState>,
  cause: Cause.Cause<Model.ModelFailure | HarnessError>,
  onTransition: () => void
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> => {
  if (Cause.hasInterrupts(cause)) {
    const partial = partialSettlement(modelEvents, "aborted")
    return abort(
      withPublication,
      "Model step interrupted",
      "aborted",
      partial === undefined ? [] : [modelSettledEvent(partial)]
    )
  }
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  const request = permissionRequired(error)
  if (request !== undefined) {
    onTransition()
    return Stream.concat(
      emitAll(withPublication, [
        new AgentEvent.PermissionRequired({
          eventType: eventType.permissionRequired,
          request
        }),
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: "error",
          outcome: "suspended"
        })
      ]),
      complete(next, {
        _tag: "Suspend",
        reason: new EngineLike.SuspendReason({
          code: "permission-required",
          message: `Permission ${request.requestId} is required`,
          details: request
        })
      })
    )
  }
  return Stream.unwrap(
    classifyFailure(error).pipe(
      Effect.map((classification) => {
        const assistantStarted = modelEvents.some(
          (event) => event.type !== "usage" && event.type !== "settle"
        )
        if (classification._tag === "ContextOverflow" && !assistantStarted && !recovered) {
          onTransition()
          return complete(next, {
            _tag: "Compact",
            state,
            recovered
          })
        }
        const failed = Stream.fail(
          failure("model_failed", "The sealed model step failed", classification.error ?? cause)
        )
        const partial = partialSettlement(modelEvents, "error")
        return partial === undefined
          ? failed
          : Stream.concat(emit(withPublication, modelSettledEvent(partial)), failed)
      })
    )
  )
}

const shouldCompact = (state: TurnState): boolean =>
  Compaction.shouldCompact({
    total: state.contextWindow.tokens.total,
    contextWindow: state.contextWindowTokens
  })

const compactableLength = (state: TurnState): number =>
  state.contextWindow.segments.filter((segment) =>
    segment.kind === "transcript" || segment.kind === "summary" || segment.kind === "steering"
  ).length

const compactState = Effect.fn("Turn.compactState")(function*(
  state: TurnState,
  engine: EngineLike.EngineLike
) {
  const selected = Compaction.selectPrefix(state.contextWindow)
  const prefixLength = selected > 0 ? selected : compactableLength(state)
  if (prefixLength === 0) {
    return yield* new HarnessError({
      code: "model_failed",
      message: "Context overflow recovery found no compactable transcript"
    })
  }
  const step = yield* Compaction.declare(state.contextWindow, prefixLength, {
    identity: "flows/harness/Turn.compaction",
    modelId: modelIdFromSeat(state.seat),
    params: state.modelParams
  }).pipe(
    Effect.catchTag("InvalidStep", (error) =>
      Effect.fail(
        new HarnessError({
          code: "invalid_step",
          message: error.message,
          cause: error
        })
      ))
  )
  const request = yield* Compaction.summaryRequest(state.contextWindow, step).pipe(
    Effect.catchTag("InvalidStep", (error) =>
      Effect.fail(
        new HarnessError({
          code: "invalid_step",
          message: error.message,
          cause: error
        })
      )),
    Effect.map((summary) =>
      ModelRequest.ModelRequest.make({
        modelId: summary.modelId,
        system: summary.system,
        messages: summary.messages,
        tools: summary.tools,
        params: summary.params,
        toolChoice: "none"
      })
    )
  )
  const events = yield* engine.sealStep({
    request,
    keyMaterial: keyMaterialFrom(state, request)
  }).pipe(
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
    Effect.mapError((error) =>
      error instanceof HarnessError
        ? error
        : new HarnessError({
          code: "model_failed",
          message: "The sealed compaction step failed",
          cause: error
        })
    )
  )
  const settlement = assistantSettlement(events)
  if (settlement === undefined) {
    return yield* new HarnessError({
      code: "model_failed",
      message: "The sealed compaction step ended without a recorded settlement"
    })
  }
  const text = settlement.message.content.filter(
    (part): part is ModelRequest.TextPart => part.type === "text"
  )
  if (text.length === 0) {
    return yield* new HarnessError({
      code: "model_failed",
      message: "The sealed compaction step returned no text summary"
    })
  }
  const summary = ModelRequest.Message.assistant(text, { stopReason: settlement.message.stopReason })
  const contextWindow = yield* Compaction.apply(state.contextWindow, step, summary).pipe(
    Effect.catchTag("InvalidStep", (error) =>
      Effect.fail(
        new HarnessError({
          code: "invalid_step",
          message: error.message,
          cause: error
        })
      ))
  )
  return {
    state: new TurnState({
      frame: state.frame,
      maxFrames: state.maxFrames,
      contextWindowTokens: state.contextWindowTokens,
      seat: state.seat,
      modelParams: state.modelParams,
      layers: state.layers,
      capabilityEnvelope: state.capabilityEnvelope,
      placement: state.placement,
      contextWindow
    }),
    // Without this the compaction is invisible to replay, which rebuilds the
    // uncompacted transcript and re-crosses the same overflow threshold.
    event: new AgentEvent.CompactionSettled({
      eventType: "flows.harness.compaction-settled.v1",
      replacedPrefixDigest: step.replacedPrefixDigest,
      summary
    })
  }
})

const closeFrame = (
  state: TurnState,
  settlement: Settlement,
  results: ReadonlyArray<Plan.ChildResult>,
  steering: Steering.Source,
  next: Deferred.Deferred<UnfoldState>,
  withPublication: WithPublication,
  engine: EngineLike.EngineLike
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> =>
  Stream.unwrap(
    Effect.fn("Turn.closeFrame")(function*() {
      let context = ContextWindow.appendTurn(
        state.contextWindow,
        settlement.message,
        results.map((result) => result.result)
      )
      const activated = results.flatMap((result) => result.result.addedToolNames)
      context = ContextWindow.activateTools(context, activated)

      const wouldIdle = results.length === 0 &&
        !settlement.message.content.some((part) => part.type === "tool-call")
      // The drain consumes host queue state, so it is a nondeterministic read
      // and must be journaled like every other boundary: a resumed run replays
      // the recorded drain instead of draining an already-drained queue, which
      // would rebuild a different context and re-key every later sealed step.
      const drained = yield* engine.record({
        name: "steering-drain",
        identity: { frame: state.frame, boundary: context.digest },
        success: Steering.DrainRecord,
        execute: steering.drain({
          boundary: `${state.frame}:${context.digest}`,
          wouldIdle
        }).pipe(Effect.map(Steering.drainRecord))
      })
      context = ContextWindow.activateTools(context, drained.activatedToolNames)
      context = appendSteering(context, drained.inserts)
      const steerContinued = drained.inserts.length > 0
      if (drained.queued) context = withoutLanding(context)
      const budgetExhausted = state.frame + 1 >= state.maxFrames
      const continuation = drained.queued ||
        (!budgetExhausted && (results.length > 0 || steerContinued))
      const events: Array<AgentEvent.AgentEvent> = [
        new AgentEvent.SteeringDrained({
          eventType: eventType.steeringDrained,
          messages: drained.inserts
        }),
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: settlement.message.stopReason,
          outcome: continuation ? "continue" : "resolved"
        })
      ]
      if (!continuation) {
        events.push(
          new AgentEvent.Resolved({
            eventType: eventType.resolved,
            message: settlement.message
          })
        )
        return Stream.concat(
          emitAll(withPublication, events),
          complete(next, { _tag: "Done" })
        )
      }

      const nextSeat = applySeatChanges(state, drained.seatChanges)
      if (nextSeat.seat !== state.seat) {
        context = ContextWindow.make({
          modelId: modelIdFromSeat(nextSeat.seat),
          segments: context.segments,
          activeTools: context.activeTools,
          replaced: context.replaced
        })
      }
      return Stream.concat(
        emitAll(withPublication, events),
        complete(next, {
          _tag: "Turn",
          recovered: false,
          state: new TurnState({
            frame: drained.queued ? 0 : state.frame + 1,
            maxFrames: state.maxFrames,
            contextWindowTokens: state.contextWindowTokens,
            seat: nextSeat.seat,
            modelParams: nextSeat.modelParams,
            layers: state.layers,
            capabilityEnvelope: state.capabilityEnvelope,
            placement: state.placement,
            contextWindow: context
          })
        })
      )
    })()
  )

const execute = (
  state: TurnState,
  settlement: Settlement,
  elaboration: Elaborate.Elaboration,
  eventBatch: Plan.Batch,
  engine: EngineLike.EngineLike,
  steering: Steering.Source,
  next: Deferred.Deferred<UnfoldState>,
  withPublication: WithPublication
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> => {
  if (elaboration.batch === undefined) {
    const results = orderedResults(
      elaboration.orderedCallIds,
      elaboration.errorResults,
      []
    )
    return Stream.concat(
      emitAll(
        withPublication,
        results.map((result) =>
          new AgentEvent.ChildResult({
            eventType: eventType.childResult,
            result
          })
        )
      ),
      closeFrame(state, settlement, results, steering, next, withPublication, engine)
    )
  }

  const settled: Array<Plan.ChildResult> = []
  const settledCallIds = new Set<string>()
  const updates = engine.splice(eventBatch).pipe(
    Stream.mapEffect((event): Effect.Effect<Result.Result<AgentEvent.AgentEvent, void>> => {
      if (event._tag === "settled") {
        if (settledCallIds.has(event.result.callId)) {
          return Effect.succeed(Result.failVoid)
        }
        settled.push(event.result)
        settledCallIds.add(event.result.callId)
        return Effect.succeed(Result.failVoid)
      }
      if (settledCallIds.has(event.callId)) {
        return Effect.succeed(Result.failVoid)
      }
      return withPublication(
        Effect.succeed(
          Result.succeed<AgentEvent.AgentEvent>(
            new AgentEvent.ChildProgress({
              eventType: eventType.childProgress,
              progress: event
            })
          )
        )
      )
    }),
    Stream.filterMap((event) => event)
  )
  const afterUpdates = Stream.suspend(() => {
    const results = orderedResults(
      elaboration.orderedCallIds,
      elaboration.errorResults,
      settled
    )
    const aborted = results.filter((result) => result.outcome === "aborted")
    if (aborted.length > 0) {
      return abort(
        withPublication,
        `Child calls aborted: ${aborted.map((result) => result.callId).join(", ")}`,
        settlement.message.stopReason,
        results.map((result) =>
          new AgentEvent.ChildResult({
            eventType: eventType.childResult,
            result
          })
        )
      )
    }
    return Stream.concat(
      emitAll(
        withPublication,
        results.map((result) =>
          new AgentEvent.ChildResult({
            eventType: eventType.childResult,
            result
          })
        )
      ),
      closeFrame(state, settlement, results, steering, next, withPublication, engine)
    )
  })
  return Stream.concat(updates, afterUpdates).pipe(
    Stream.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) {
        const interrupted = eventBatch.children
          .filter((child) => !settledCallIds.has(child.callId))
          .map((child) => abortedToolResult(child.callId))
        const results = orderedResults(
          elaboration.orderedCallIds,
          elaboration.errorResults,
          [...settled, ...interrupted]
        )
        return abort(
          withPublication,
          "Child batch interrupted",
          settlement.message.stopReason,
          results.map((result) =>
            new AgentEvent.ChildResult({
              eventType: eventType.childResult,
              result
            })
          )
        )
      }
      const error = Option.getOrUndefined(Cause.findErrorOption(cause))
      const request = error === undefined ? undefined : permissionRequired(error)
      if (request !== undefined) {
        return Stream.concat(
          emitAll(withPublication, [
            new AgentEvent.PermissionRequired({
              eventType: eventType.permissionRequired,
              request
            }),
            new AgentEvent.TurnClosed({
              eventType: eventType.turnClosed,
              stopReason: settlement.message.stopReason,
              outcome: "suspended"
            })
          ]),
          complete(next, {
            _tag: "Suspend",
            reason: new EngineLike.SuspendReason({
              code: "permission-required",
              message: `Permission ${request.requestId} is required`,
              details: request
            })
          })
        )
      }
      if (error instanceof HarnessError) {
        return Stream.fail(error)
      }
      return Stream.fail(
        failure(
          "engine_failed",
          "The engine failed to splice the elaborated batch",
          error ?? cause
        )
      )
    })
  )
}

const afterSettlement = (
  state: TurnState,
  settlement: Settlement,
  catalog: Elaborate.Catalog,
  engine: EngineLike.EngineLike,
  steering: Steering.Source,
  next: Deferred.Deferred<UnfoldState>,
  withPublication: WithPublication
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> =>
  Stream.unwrap(
    Effect.fn("Turn.afterSettlement")(function*() {
      if (settlement.message.stopReason === "aborted") {
        return abort(withPublication, "Model step settled as aborted")
      }

      let elaboration: Elaborate.Elaboration
      if (isLandingFrame(state)) {
        const calls = settlement.message.content.filter(
          (part): part is ModelRequest.ToolCallPart => part.type === "tool-call"
        )
        elaboration = {
          batch: undefined,
          orderedCallIds: calls.map((call) => call.id),
          errorResults: calls.map((call) =>
            ModelRequest.ToolResultPart.make({
              toolCallId: call.id,
              content: "Tools are disabled after the maximum harness frames."
            })
          )
        }
      } else {
        try {
          elaboration = Elaborate.elaborate(settlement.message, catalog)
        } catch (cause) {
          return yield* new HarnessError({
            code: "elaboration_failed",
            message: "Unable to elaborate the recorded model message",
            cause
          })
        }
      }
      const eventBatch = new Plan.Batch({
        children: (elaboration.batch?.children ?? []).map((child) =>
          new Plan.Child({
            flowName: child.flowName,
            callId: child.callId,
            args: child.args,
            capabilities: child.capabilities,
            effects: child.effects,
            placement: child.placement
          })
        )
      })
      return Stream.concat(
        emit(
          withPublication,
          new AgentEvent.Elaborated({
            eventType: eventType.elaborated,
            batch: eventBatch
          })
        ),
        execute(
          state,
          settlement,
          elaboration,
          eventBatch,
          engine,
          steering,
          next,
          withPublication
        )
      )
    })()
  )

const modelPhase = (
  state: TurnState,
  recovered: boolean,
  catalog: Elaborate.Catalog,
  engine: EngineLike.EngineLike,
  steering: Steering.Source,
  next: Deferred.Deferred<UnfoldState>,
  withPublication: WithPublication
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> =>
  Stream.unwrap(
    requestFrom(state).pipe(
      Effect.map((request) => {
        const modelEvents: Array<ModelEvent.ModelEvent> = []
        let transitioned = false
        const deltas = engine.sealStep({
          request,
          keyMaterial: keyMaterialFrom(state, request)
        }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              modelEvents.push(event)
            })
          ),
          Stream.filter((event) => event.type !== "settle"),
          Stream.mapEffect((delta) =>
            withPublication(
              Effect.succeed(
                new AgentEvent.ModelDelta({
                  eventType: eventType.modelDelta,
                  delta
                })
              )
            )
          ),
          Stream.catchCause((cause) =>
            modelFailure(
              state,
              recovered,
              modelEvents,
              withPublication,
              next,
              cause,
              () => {
                transitioned = true
              }
            )
          )
        )
        const settled = Stream.unwrap(
          Effect.uninterruptibleMask(() =>
            Effect.sync(() => {
              if (transitioned) {
                return Stream.empty
              }
              const settlement = assistantSettlement(modelEvents)
              if (settlement === undefined) {
                return abort(
                  withPublication,
                  "Model step ended without a recorded settlement"
                )
              }
              return Stream.concat(
                emit(
                  withPublication,
                  modelSettledEvent(settlement)
                ),
                afterSettlement(
                  state,
                  settlement,
                  catalog,
                  engine,
                  steering,
                  next,
                  withPublication
                )
              )
            })
          )
        )
        return Stream.concat(deltas, settled)
      })
    )
  )

const runFrame = (
  state: TurnState,
  recovered: boolean,
  catalog: Elaborate.Catalog,
  engine: EngineLike.EngineLike,
  steering: Steering.Source,
  next: Deferred.Deferred<UnfoldState>,
  withPublication: WithPublication
): Stream.Stream<AgentEvent.AgentEvent, HarnessError> =>
  Stream.concat(
    emit(
      withPublication,
      new AgentEvent.TurnOpened({
        eventType: eventType.turnOpened,
        seat: state.seat,
        modelParams: state.modelParams,
        activeToolNames: isLandingFrame(state) ? [] : state.contextWindow.activeTools,
        contextDigest: state.contextWindow.digest
      })
    ),
    modelPhase(
      state,
      recovered,
      catalog,
      engine,
      steering,
      next,
      withPublication
    )
  )

/**
 * Runs the six-phase turn cycle as an effectful unfold over serializable state.
 *
 * Effect 4 names the former `Stream.unfoldEffect` constructor
 * `Stream.unfold`. Each unfold transition is one engine-owned turn frame; the
 * harness delegates the complete child batch to `EngineLike.splice` and never
 * schedules or executes a child itself.
 *
 * @category streams
 * @since 0.1.0
 */
export const run = (
  input: Input
): Stream.Stream<
  AgentEvent.AgentEvent,
  HarnessError,
  EngineLike.EngineLike | Steering.Source
> =>
  Stream.unwrap(
    Effect.fn("Turn.run")(function*() {
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const frames = Stream.unfold<
        UnfoldState,
        Stream.Stream<AgentEvent.AgentEvent, HarnessError>,
        HarnessError,
        EngineLike.EngineLike | Steering.Source
      >(
        { _tag: "Turn", state: input.state, recovered: false },
        (current) => {
          switch (current._tag) {
            case "Done":
              return Effect.succeed(undefined)
            case "Fail":
              return Effect.fail(current.error)
            case "Suspend":
              return Effect.gen(function*() {
                const engine = yield* EngineLike.EngineLike
                return yield* engine.suspend(current.reason)
              })
            case "Await":
              return Deferred.await(current.next).pipe(
                Effect.map((state) => [Stream.empty, state] as const)
              )
            case "Compact":
              return Effect.gen(function*() {
                const engine = yield* EngineLike.EngineLike
                const compacted = yield* compactState(current.state, engine)
                return [
                  emitAll(withPublication, [compacted.event]),
                  {
                    _tag: "Turn",
                    state: compacted.state,
                    recovered: true
                  } satisfies UnfoldState
                ] as const
              })
            case "Turn":
              if (current.state.frame >= current.state.maxFrames) {
                return Effect.succeed(
                  [
                    Stream.empty,
                    { _tag: "Done" } satisfies UnfoldState
                  ] as const
                )
              }
              if (
                !current.recovered &&
                !isLandingFrame(current.state) &&
                shouldCompact(current.state)
              ) {
                return Effect.succeed(
                  [
                    Stream.empty,
                    {
                      _tag: "Compact",
                      state: current.state,
                      recovered: current.recovered
                    } satisfies UnfoldState
                  ] as const
                )
              }
              return Effect.gen(function*() {
                const engine = yield* EngineLike.EngineLike
                const steering = yield* Steering.Source
                const next = yield* Deferred.make<UnfoldState>()
                const state = withLanding(current.state)
                return [
                  runFrame(
                    state,
                    current.recovered,
                    input.catalog,
                    engine,
                    steering,
                    next,
                    withPublication
                  ),
                  { _tag: "Await", next } satisfies UnfoldState
                ] as const
              })
          }
        }
      )
      return frames.pipe(Stream.flatMap((frame) => frame))
    })()
  )
