/**
 * The cell-first controller.
 *
 * Smithers is a state machine. This module is its deterministic outer loop: it
 * decides continue, park, or finish from durable evidence — the transition a
 * cell returned and the budgets the run declared — and never from the presence
 * of a provider tool call.
 *
 * One frame is: seal a model step, recover the cell from the settlement, run it
 * in the sandbox, resolve each of its flow calls as its own keyed durable
 * boundary, then apply the transition it returned. The cell owns the state that
 * carries forward and the exact context the next frame sees.
 *
 * Governing design: `docs/specs/Concepts/Durable Cell Loop.md`.
 *
 * @since 0.1.0
 */
import { Effects, type KeyMaterial, Placement } from "@smthrs/core"
import { Capability, CapabilitySet, Permission } from "@smthrs/kernel"
import { CanonicalJson, type Model, ModelEvent, ModelRequest } from "@smthrs/model"
import { Descriptor } from "@smthrs/registry"
import { Effect, Option, Queue, Result, Schema, Stream } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import * as Cell from "./Cell.ts"
import * as Compaction from "./Compaction.ts"
import * as ContextWindow from "./ContextWindow.ts"
import * as EngineLike from "./EngineLike.ts"
import { HarnessError } from "./HarnessError.ts"
import * as cellPrompt from "./internal/cellPrompt.ts"
import * as Sandbox from "./Sandbox.ts"
import * as Steering from "./Steering.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Default number of frames one admitted task may spend.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultMaxFrames = 100

const MaxFrames = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(defaultMaxFrames)),
  Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxFrames))
)

/**
 * The resolved model's context window, in tokens. Zero disables compaction,
 * which is what a host that has not resolved a capability record should get.
 */
const ContextWindowTokens = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(0)),
  Schema.withDecodingDefaultKey(Effect.succeed(0))
)

const eventType = {
  aborted: "flows.harness.aborted.v1",
  cellCallSettled: "flows.harness.cell-call-settled.v1",
  cellCallStarted: "flows.harness.cell-call-started.v1",
  cellProduced: "flows.harness.cell-produced.v1",
  cellSettled: "flows.harness.cell-settled.v1",
  compactionSettled: "flows.harness.compaction-settled.v1",
  modelDelta: "flows.harness.model-delta.v1",
  modelSettled: "flows.harness.model-settled.v1",
  permissionRequired: "flows.harness.permission-required.v1",
  resolved: "flows.harness.resolved.v1",
  steeringDrained: "flows.harness.steering-drained.v1",
  suspended: "flows.harness.suspended.v1",
  transitionApplied: "flows.harness.transition-applied.v1",
  turnClosed: "flows.harness.turn-closed.v1",
  turnOpened: "flows.harness.turn-opened.v1"
} as const

/**
 * The serializable state carried across cell frames.
 *
 * `agentState` is the cell's own durable memory: the harness stores and
 * replays it verbatim and never interprets it. Anything too large for the
 * transcript belongs behind a state or artifact flow, not in here.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class State extends Schema.Class<State>("flows/harness/CellTurn/State")({
  session: Schema.String,
  frame: NonNegativeSafeInt,
  maxFrames: MaxFrames,
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  layers: Schema.Array(Schema.String),
  capabilityEnvelope: Schema.Array(Capability.CapabilityPattern),
  placement: Schema.Option(Descriptor.Placement),
  contextWindow: ContextWindow.ContextWindow,
  contextWindowTokens: ContextWindowTokens,
  agentState: Schema.Json,
  /**
   * Whether this run's first `complete` has already been challenged.
   *
   * The controller accepts a completion only after one audit bounce: the
   * first `complete` is answered with a demand for host-observable evidence
   * and another frame, the second is accepted unconditionally. A model will
   * claim "implemented the fix" without ever editing a file — one benchmark
   * run closed with exactly that claim after 16 read-only calls — and prose
   * rules alone did not stop it. Sticky once set, so the gate costs one frame
   * per run, never one per completion attempt.
   */
  completionChallenged: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  )
}) {}

/**
 * Runtime declarations used to interpret serializable controller state.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input {
  readonly state: State
  /** The flows this frame may call, already narrowed by seat visibility. */
  readonly flows: ReadonlyArray<Descriptor.FlowDescriptor>
  readonly limits?: Sandbox.Limits | undefined
}

/**
 * Constructs an initial controller state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: {
  readonly session: string
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly layers: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly placement: Option.Option<Descriptor.Placement>
  readonly contextWindow: ContextWindow.ContextWindow
  readonly contextWindowTokens?: number | undefined
  readonly agentState?: Schema.Json | undefined
  readonly frame?: number | undefined
  readonly maxFrames?: number | undefined
  /**
   * Arms the completion audit: the run's first `complete` is answered with a
   * demand for host-observable evidence, and only the second is accepted.
   * Off by default — a conversational cell's completion is the reply itself
   * and must not pay a bounce; a task run's completion is a claim about the
   * world and should.
   */
  readonly auditCompletion?: boolean | undefined
}): State =>
  new State({
    session: options.session,
    frame: options.frame ?? 0,
    maxFrames: options.maxFrames ?? defaultMaxFrames,
    seat: options.seat,
    modelParams: options.modelParams,
    layers: options.layers,
    capabilityEnvelope: options.capabilityEnvelope,
    placement: options.placement,
    contextWindow: options.contextWindow,
    contextWindowTokens: options.contextWindowTokens ?? 0,
    agentState: options.agentState ?? null,
    completionChallenged: !(options.auditCompletion ?? false)
  })

/**
 * Prepends the cell contract and the callable-flow catalog to a context window.
 *
 * The model is taught one thing — how to write a cell — and shown exactly the
 * flows this frame may call. Both land in prefix segments, which every
 * transition preserves, so the teaching is stable for the run and a cell's
 * projected context never has to carry it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const teach = (
  contextWindow: ContextWindow.ContextWindow,
  flows: ReadonlyArray<Descriptor.FlowDescriptor>
): ContextWindow.ContextWindow => {
  const projections: Record<string, Cell.FlowProjection> = {}
  for (const descriptor of flows) projections[descriptor.name] = Cell.project(descriptor)
  const taught = cellPrompt.make(projections).map((section) =>
    ContextWindow.makeSegment({
      kind: "system",
      zone: "prefix",
      declaredDigest: section.digest,
      content: [ModelRequest.SystemPart.make({ text: section.text })]
    })
  )
  return ContextWindow.make({
    modelId: contextWindow.modelId,
    segments: [...taught, ...contextWindow.segments],
    activeTools: contextWindow.activeTools,
    replaced: contextWindow.replaced
  })
}

const modelIdFromSeat = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

const placementFrom = (state: State): Placement.Placement | undefined =>
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
  state: State,
  request: ModelRequest.ModelRequest
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v1",
  kind: "sealed",
  body: { _tag: "ModelCall", request },
  inputs: [{ _tag: "Literal", value: { contextDigest: state.contextWindow.digest } }],
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

/**
 * Renders the durable state for the system context.
 *
 * The full value is the cell's `ctx.state` binding, so the prompt only needs
 * enough to plan with: the whole JSON while it is small, and a key roster with
 * sizes once it is not. Re-printing a large state every frame both paid its
 * bytes twice and taught the model to treat the prompt as the store — the
 * roster is Prime Agent's `<ipython_state>` pattern, naming what survives
 * outside the transcript instead of hauling it back in.
 */
const stateTeaching = (agentState: Schema.Json): string => {
  const rendered = CanonicalJson.stringify(agentState)
  if (rendered.length <= 2048) {
    return `Agent-owned durable state for this frame (JSON), also available in the cell as ctx.state:\n${rendered}`
  }
  const roster = agentState !== null && typeof agentState === "object" && !Array.isArray(agentState)
    ? Object.entries(agentState)
      .map(([key, value]) => `- ${key} (${JSON.stringify(value)?.length ?? 4} bytes)`)
      .join("\n")
    : `(${rendered.length} bytes)`
  return `Agent-owned durable state for this frame is ${rendered.length} bytes and is available in the cell as ctx.state. Its keys:\n${roster}\nRead what you need from ctx.state instead of reconstructing it.`
}

const requestFrom = (state: State): Result.Result<ModelRequest.ModelRequest, HarnessError> => {
  let rendered: ModelRequest.ModelRequest
  try {
    rendered = ContextWindow.render(state.contextWindow)
  } catch (cause) {
    return Result.fail(
      new HarnessError({
        code: "render_failed",
        message: "Unable to render the context window",
        cause
      })
    )
  }
  return Result.succeed(
    ModelRequest.ModelRequest.make({
      modelId: modelIdFromSeat(state.seat),
      system: [
        ...rendered.system,
        ModelRequest.SystemPart.make({ text: stateTeaching(state.agentState) })
      ],
      messages: rendered.messages,
      // A cell-first frame never declares provider tools: the cell is the plan
      // and `ctx.call` is the only invocation path.
      tools: [],
      toolChoice: "none",
      params: state.modelParams
    })
  )
}

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .filter((part): part is ModelRequest.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const permissionRequired = (error: unknown): Permission.PermissionRequired | undefined => {
  if (error instanceof Permission.PermissionRequired) return error
  if (error instanceof HarnessError && error.cause instanceof Permission.PermissionRequired) return error.cause
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Permission.PermissionRequired)(
      error instanceof HarnessError ? error.cause : error
    )
  )
}

/**
 * Appends one observation turn to the transcript.
 *
 * A malformed cell, a thrown cell, or a rejected transition is durable
 * evidence, not a crash: the assistant text stays on the record and the
 * harness states plainly what went wrong so the next frame can fix it.
 */
const observed = (
  state: State,
  assistant: ModelRequest.AssistantMessage,
  observation: string
): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: state.contextWindow.modelId,
    segments: [
      ...state.contextWindow.segments,
      ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [assistant, ModelRequest.Message.user(observation)]
      })
    ],
    activeTools: state.contextWindow.activeTools,
    replaced: state.contextWindow.replaced
  })

/**
 * Replaces the transcript with exactly the context the cell projected.
 *
 * Prefix segments — system teaching, registry disclosure, instructions — are
 * fixed for the run and survive; everything the model sees beyond them is the
 * cell's choice.
 */
const projected = (
  state: State,
  entries: ReadonlyArray<Cell.ContextEntry>,
  steered: ReadonlyArray<ModelRequest.Message>
): ContextWindow.ContextWindow => {
  const messages = [...entries.map(Cell.renderEntry), ...steered]
  return ContextWindow.make({
    modelId: state.contextWindow.modelId,
    segments: [
      ...state.contextWindow.segments.filter((segment) => segment.zone === "prefix"),
      ...(messages.length === 0
        ? []
        : [ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content: messages })])
    ],
    activeTools: state.contextWindow.activeTools,
    replaced: state.contextWindow.replaced
  })
}

const completionAudit = (claimed: string): string =>
  `Completion review — this run does not accept a completion on its first attempt. Audit your claim against host-observable evidence from THIS run: quote the exact command you ran and its passing output that proves the task is done (for a code change, the project check run AFTER your edit). If you cannot quote such evidence, the work is not finished — finish it now, verify it, and then return complete again. If your evidence is real, return complete again unchanged. Your claimed output was: ${
    claimed.length > 400 ? `${claimed.slice(0, 399)}…` : claimed
  }`

const budgetMessage = (state: State): string =>
  `The frame budget of ${state.maxFrames} is exhausted. The run stops here; the last transition was a request to continue.`

/**
 * Resolves one cell call into a durable engine boundary.
 *
 * Resolution happens here, at the boundary, and not inside the sandbox: the
 * flow must exist in the catalog this frame was given, and every capability it
 * declares must still be inside the run's narrowed envelope. Both denials are
 * ordinary call failures the cell can catch, which is what lets an agent
 * discover the shape of its authority without crashing the run.
 */
const callHandler = (
  state: State,
  cell: Cell.Source,
  descriptors: ReadonlyMap<string, Descriptor.FlowDescriptor>,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Sandbox.Handler =>
(invocation) =>
  Effect.gen(function*() {
    const descriptor = descriptors.get(invocation.flow)
    if (descriptor === undefined) {
      return new Cell.CallResult({
        outcome: "failure",
        value: null,
        message: `Unknown flow ${invocation.flow}. Only the flows in ctx.flows are callable.`
      })
    }
    const envelope = CapabilitySet.fromPatterns(state.capabilityEnvelope)
    const refused = descriptor.capabilities.filter((declared) =>
      Option.match(Capability.parse(declared), {
        onNone: () => true,
        onSome: (capability) => !CapabilitySet.allows(envelope, capability)
      })
    )
    if (refused.length > 0) {
      return new Cell.CallResult({
        outcome: "failure",
        value: null,
        message: `Flow ${invocation.flow} needs ${refused.join(", ")}, which is outside this run's capability envelope.`
      })
    }
    const call = new Cell.Call({
      flowName: descriptor.name,
      input: invocation.input,
      capabilities: descriptor.capabilities,
      effects: descriptor.effects,
      placement: descriptor.placement,
      identity: new Cell.CallIdentity({
        session: state.session,
        frame: state.frame,
        cell: cell.digest,
        ordinal: invocation.ordinal,
        declaration: Cell.declarationDigest(descriptor),
        layers: [...new Set(state.layers)].sort()
      })
    })
    yield* emit(new AgentEvent.CellCallStarted({ eventType: eventType.cellCallStarted, call }))
    const result = yield* engine.call(call)
    yield* emit(
      new AgentEvent.CellCallSettled({
        eventType: eventType.cellCallSettled,
        flowName: call.flowName,
        identity: call.identity,
        result
      })
    )
    return result
  })

const invalidStep = (error: Compaction.InvalidStep): HarnessError =>
  new HarnessError({ code: "invalid_step", message: error.message, cause: error })

/**
 * Compacts the frame's context before the model is asked anything.
 *
 * Compaction is a transition of the run, not a repair applied to a request on
 * its way out: the summary is produced by its own sealed step, so it is keyed
 * and journaled like every other model call, and the settlement is emitted as
 * `CompactionSettled`. Without that event a replay rebuilds the uncompacted
 * transcript, re-crosses the same threshold, and re-keys every later frame — so
 * emitting it is what makes the compacted window part of the run's durable
 * state rather than an artifact of when the process happened to notice.
 *
 * Nothing here is best-effort. A window that cannot be compacted stays as it
 * is; a compaction the model started and could not finish is a typed failure.
 */
const compacted = (
  state: State,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<State, HarnessError | Model.ModelFailure> =>
  Effect.gen(function*() {
    const over = Compaction.shouldCompact({
      total: state.contextWindow.tokens.total,
      contextWindow: state.contextWindowTokens
    })
    if (!over) return state
    const prefixLength = Compaction.selectPrefix(state.contextWindow)
    // Nothing compactable is not a failure: a window that is all prefix has
    // already given up everything it can, and the frame proceeds as declared.
    if (prefixLength === 0) return state
    const step = yield* Compaction.declare(state.contextWindow, prefixLength, {
      identity: "flows/harness/CellTurn.compaction",
      modelId: modelIdFromSeat(state.seat),
      params: state.modelParams
    }).pipe(Effect.catchTag("InvalidStep", (error) => Effect.fail(invalidStep(error))))
    const summaryRequest = yield* Compaction.summaryRequest(state.contextWindow, step).pipe(
      Effect.catchTag("InvalidStep", (error) => Effect.fail(invalidStep(error)))
    )
    const request = ModelRequest.ModelRequest.make({
      modelId: summaryRequest.modelId,
      system: summaryRequest.system,
      messages: summaryRequest.messages,
      tools: [],
      toolChoice: "none",
      params: summaryRequest.params
    })
    const events = yield* Stream.runCollect(
      engine.sealStep({ request, keyMaterial: keyMaterialFrom(state, request) })
    ).pipe(Effect.map((collected) => Array.from(collected)))
    if (!events.some((event) => event.type === "settle")) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed compaction step ended without a recorded settlement"
      })
    }
    const settled = ModelEvent.ModelEvent.settledMessage(events)
    const text = settled.message.content.filter(
      (part): part is ModelRequest.TextPart => part.type === "text"
    )
    if (text.length === 0) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed compaction step returned no text summary"
      })
    }
    const summary = ModelRequest.Message.assistant(text, { stopReason: settled.message.stopReason })
    const contextWindow = yield* Compaction.apply(state.contextWindow, step, summary).pipe(
      Effect.catchTag("InvalidStep", (error) => Effect.fail(invalidStep(error)))
    )
    yield* emit(
      new AgentEvent.CompactionSettled({
        eventType: eventType.compactionSettled,
        replacedPrefixDigest: step.replacedPrefixDigest,
        summary
      })
    )
    return new State({
      session: state.session,
      frame: state.frame,
      maxFrames: state.maxFrames,
      seat: state.seat,
      modelParams: state.modelParams,
      layers: state.layers,
      capabilityEnvelope: state.capabilityEnvelope,
      placement: state.placement,
      contextWindow,
      contextWindowTokens: state.contextWindowTokens,
      agentState: state.agentState,
      completionChallenged: state.completionChallenged
    })
  })

/**
 * The step the controller takes after one frame settles.
 */
type Step =
  | { readonly _tag: "Continue"; readonly state: State }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Suspend"; readonly reason: EngineLike.SuspendReason }

const frame = (
  input: Input,
  engine: EngineLike.EngineLike,
  sandbox: Sandbox.Sandbox,
  steering: Steering.Source,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<Step, HarnessError | Sandbox.SandboxError | Model.ModelFailure> =>
  Effect.gen(function*() {
    // Compaction happens before the turn opens, so the digest the turn records
    // is the one the sealed step is actually keyed on.
    const state = yield* compacted(input.state, engine, emit)
    const descriptors = new Map(input.flows.map((descriptor) => [descriptor.name, descriptor]))
    const projections: Record<string, Cell.FlowProjection> = {}
    for (const descriptor of input.flows) projections[descriptor.name] = Cell.project(descriptor)

    yield* emit(
      new AgentEvent.TurnOpened({
        eventType: eventType.turnOpened,
        seat: state.seat,
        modelParams: state.modelParams,
        activeToolNames: [],
        contextDigest: state.contextWindow.digest
      })
    )

    const request = yield* Effect.fromResult(requestFrom(state))
    const events = yield* Stream.runCollect(
      engine.sealStep({ request, keyMaterial: keyMaterialFrom(state, request) })
    ).pipe(Effect.map((collected) => Array.from(collected)))
    for (const event of events) {
      if (event.type === "settle") continue
      yield* emit(new AgentEvent.ModelDelta({ eventType: eventType.modelDelta, delta: event }))
    }
    if (!events.some((event) => event.type === "settle")) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed model step ended without a recorded settlement"
      })
    }
    const settled = ModelEvent.ModelEvent.settledMessage(events)
    yield* emit(
      new AgentEvent.ModelSettled({
        eventType: eventType.modelSettled,
        message: settled.message,
        usage: settled.usage
      })
    )

    /** Records an unusable frame and asks for another, budget permitting. */
    const observe = (note: string): Step => {
      if (state.frame + 1 >= state.maxFrames) return { _tag: "Done" }
      return {
        _tag: "Continue",
        state: new State({
          session: state.session,
          frame: state.frame + 1,
          maxFrames: state.maxFrames,
          seat: state.seat,
          modelParams: state.modelParams,
          layers: state.layers,
          capabilityEnvelope: state.capabilityEnvelope,
          placement: state.placement,
          contextWindow: observed(state, settled.message, note),
          contextWindowTokens: state.contextWindowTokens,
          agentState: state.agentState,
          completionChallenged: state.completionChallenged
        })
      }
    }

    const extracted = Cell.extract(assistantText(settled.message))
    if (extracted._tag === "Failure") {
      const rejection = extracted.failure
      yield* emit(
        new AgentEvent.CellSettled({
          eventType: eventType.cellSettled,
          cell: "",
          outcome: rejection
        })
      )
      const step = observe(rejection.message)
      if (step._tag === "Done") {
        yield* emit(
          new AgentEvent.TurnClosed({
            eventType: eventType.turnClosed,
            stopReason: settled.message.stopReason,
            outcome: "resolved"
          })
        )
        yield* emit(
          new AgentEvent.Resolved({
            eventType: eventType.resolved,
            message: ModelRequest.Message.assistant(budgetMessage(state), { stopReason: "stop" })
          })
        )
        return step
      }
      yield* emit(
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: settled.message.stopReason,
          outcome: "continue"
        })
      )
      return step
    }

    const cell = extracted.success
    yield* emit(new AgentEvent.CellProduced({ eventType: eventType.cellProduced, cell }))

    // Every call the frame settles is remembered so a raise can hand the
    // model its partial work. Without this, one uncaught throw discarded the
    // frame's reads and the next cell re-did them — often raising the same
    // way again. Prime Agent's tool errors return stdout-so-far plus the
    // traceback for exactly this reason.
    const observedCalls: Array<{ readonly flow: string; readonly ok: boolean; readonly summary: string }> = []
    const observing: Sandbox.Handler = (invocation) =>
      callHandler(state, cell, descriptors, engine, emit)(invocation).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const rendered = result.outcome === "success"
              ? JSON.stringify(result.value) ?? "null"
              : result.message ?? "failed"
            observedCalls.push({
              flow: invocation.flow,
              ok: result.outcome === "success",
              summary: rendered.length > 400 ? `${rendered.slice(0, 399)}…` : rendered
            })
          })
        )
      )
    const outcome = yield* sandbox.evaluate({
      cell,
      flows: projections,
      call: observing,
      state: state.agentState,
      limits: input.limits
    })
    yield* emit(
      new AgentEvent.CellSettled({ eventType: eventType.cellSettled, cell: cell.digest, outcome })
    )

    if (outcome._tag !== "settled") {
      const salvage = observedCalls.length === 0
        ? ""
        : `\nCalls this cell already completed (their results are durable; use them instead of redoing the work):\n${
          observedCalls.map((call) => `- ${call.flow} -> ${call.ok ? "ok" : "FAILED"}: ${call.summary}`).join("\n")
        }`
      const note = outcome._tag === "raised"
        ? `The cell threw ${outcome.name}: ${outcome.message}. Emit a corrected cell.${salvage}`
        : `${outcome.message}${salvage}`
      const step = observe(note)
      yield* emit(
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: settled.message.stopReason,
          outcome: step._tag === "Done" ? "resolved" : "continue"
        })
      )
      if (step._tag === "Done") {
        yield* emit(
          new AgentEvent.Resolved({
            eventType: eventType.resolved,
            message: ModelRequest.Message.assistant(budgetMessage(state), { stopReason: "stop" })
          })
        )
      }
      return step
    }

    const transition = outcome.transition
    yield* emit(
      new AgentEvent.TransitionApplied({
        eventType: eventType.transitionApplied,
        transition
      })
    )

    if (transition._tag === "park") {
      yield* emit(
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: settled.message.stopReason,
          outcome: "suspended"
        })
      )
      return {
        _tag: "Suspend",
        reason: new EngineLike.SuspendReason({
          code: transition.reason,
          message: transition.message
        })
      }
    }

    if (transition._tag === "complete") {
      // The audit bounce. A completion inside the frame budget is accepted
      // only on its second attempt: the first is answered with a demand for
      // evidence, because the claim "done" is the one output the model can
      // produce without doing anything. A completion on the final frame is
      // accepted as-is — bouncing it into the budget wall would discard a
      // possibly true answer for a certainly empty one.
      if (!state.completionChallenged && state.frame + 1 < state.maxFrames) {
        yield* emit(
          new AgentEvent.TurnClosed({
            eventType: eventType.turnClosed,
            stopReason: settled.message.stopReason,
            outcome: "continue"
          })
        )
        return {
          _tag: "Continue",
          state: new State({
            session: state.session,
            frame: state.frame + 1,
            maxFrames: state.maxFrames,
            seat: state.seat,
            modelParams: state.modelParams,
            layers: state.layers,
            capabilityEnvelope: state.capabilityEnvelope,
            placement: state.placement,
            contextWindow: observed(state, settled.message, completionAudit(transition.output)),
            contextWindowTokens: state.contextWindowTokens,
            agentState: transition.state,
            completionChallenged: true
          })
        }
      }
      yield* emit(
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: settled.message.stopReason,
          outcome: "resolved"
        })
      )
      yield* emit(
        new AgentEvent.Resolved({
          eventType: eventType.resolved,
          message: ModelRequest.Message.assistant(transition.output, { stopReason: "stop" })
        })
      )
      return { _tag: "Done" }
    }

    // The drain consumes host queue state, so it is a nondeterministic read
    // and must be journaled like every other boundary: a resumed run replays
    // the recorded drain instead of draining an already-drained queue, which
    // would rebuild a different context and re-key every later sealed step.
    const drained = yield* engine.record({
      name: "steering-drain",
      identity: { session: state.session, frame: state.frame, boundary: cell.digest },
      success: Steering.DrainRecord,
      execute: steering.drain({
        boundary: `${state.frame}:${cell.digest}`,
        wouldIdle: false
      }).pipe(Effect.map(Steering.drainRecord))
    })
    yield* emit(
      new AgentEvent.SteeringDrained({
        eventType: eventType.steeringDrained,
        messages: drained.inserts
      })
    )
    if (state.frame + 1 >= state.maxFrames) {
      yield* emit(
        new AgentEvent.TurnClosed({
          eventType: eventType.turnClosed,
          stopReason: settled.message.stopReason,
          outcome: "resolved"
        })
      )
      yield* emit(
        new AgentEvent.Resolved({
          eventType: eventType.resolved,
          message: ModelRequest.Message.assistant(budgetMessage(state), { stopReason: "stop" })
        })
      )
      return { _tag: "Done" }
    }
    yield* emit(
      new AgentEvent.TurnClosed({
        eventType: eventType.turnClosed,
        stopReason: settled.message.stopReason,
        outcome: "continue"
      })
    )
    let seat = state.seat
    let modelParams = state.modelParams
    for (const change of drained.seatChanges) {
      if (change._tag === "SeatChange") seat = change.seat
      else {
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
    const context = projected(state, transition.context, drained.inserts)
    return {
      _tag: "Continue",
      state: new State({
        session: state.session,
        frame: state.frame + 1,
        maxFrames: state.maxFrames,
        seat,
        modelParams,
        layers: state.layers,
        capabilityEnvelope: state.capabilityEnvelope,
        placement: state.placement,
        contextWindow: seat === state.seat ? context : ContextWindow.make({
          modelId: modelIdFromSeat(seat),
          segments: context.segments,
          activeTools: context.activeTools,
          replaced: context.replaced
        }),
        contextWindowTokens: state.contextWindowTokens,
        agentState: transition.state,
        completionChallenged: state.completionChallenged
      })
    }
  })

/**
 * Runs the cell loop until it completes, parks, or exhausts its budget.
 *
 * Cancellation is fiber interruption: interrupting this stream tears down the
 * sandbox through scope closure and reports one abort, without threading an
 * abort signal anywhere.
 *
 * @category streams
 * @since 0.1.0
 * @slop
 */
export const run = (
  input: Input
): Stream.Stream<
  AgentEvent.AgentEvent,
  HarnessError,
  EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source
> =>
  Stream.callback<
    AgentEvent.AgentEvent,
    HarnessError,
    EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source
  >((queue) => {
    const emit = (event: AgentEvent.AgentEvent): Effect.Effect<void> => Effect.asVoid(Queue.offer(queue, event))
    const loop = Effect.gen(function*() {
      const engine = yield* EngineLike.EngineLike
      const sandbox = yield* Sandbox.Sandbox
      const steering = yield* Steering.Source

      let current = input.state
      for (;;) {
        const step = yield* frame({ ...input, state: current }, engine, sandbox, steering, emit).pipe(
          Effect.catch((error) => {
            const request = permissionRequired(error)
            if (request === undefined) {
              return Effect.fail(
                error instanceof HarnessError ? error : new HarnessError({
                  code: error instanceof Sandbox.SandboxError ? "engine_failed" : "model_failed",
                  message: "The cell frame failed",
                  cause: error
                })
              )
            }
            return Effect.gen(function*() {
              yield* emit(
                new AgentEvent.PermissionRequired({
                  eventType: eventType.permissionRequired,
                  request
                })
              )
              yield* emit(
                new AgentEvent.TurnClosed({
                  eventType: eventType.turnClosed,
                  stopReason: "error",
                  outcome: "suspended"
                })
              )
              return {
                _tag: "Suspend",
                reason: new EngineLike.SuspendReason({
                  code: "permission-required",
                  message: `Permission ${request.requestId} is required`,
                  details: request
                })
              } satisfies Step
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              yield* emit(new AgentEvent.Aborted({ eventType: eventType.aborted, reason: "Cell frame interrupted" }))
              yield* emit(
                new AgentEvent.TurnClosed({
                  eventType: eventType.turnClosed,
                  stopReason: "aborted",
                  outcome: "aborted"
                })
              )
            })
          )
        )
        if (step._tag === "Done") return
        if (step._tag === "Suspend") {
          yield* emit(new AgentEvent.Suspended({ eventType: eventType.suspended, reason: step.reason }))
          return yield* engine.suspend(step.reason)
        }
        current = step.state
      }
    })
    // The queue, not the callback's error channel, terminates the stream, so
    // every event already offered stays observable ahead of whatever ended the
    // run. An interruption is forwarded rather than swallowed: a durable park
    // arrives as one, and turning it into a clean end would report a suspended
    // run as a finished one.
    return Effect.onExit(loop, (exit) =>
      Effect.asVoid(
        exit._tag === "Success" ? Queue.end(queue) : Queue.failCause(queue, exit.cause)
      ))
  })
