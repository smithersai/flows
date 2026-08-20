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
import { Clock, Effect, Option, Queue, Result, Schema, Stream } from "effect"
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

/**
 * Default number of consecutive read-only frames a task run may spend.
 *
 * Read-only means the frame made no call that declares a write: searching,
 * reading, and running commands under a read-only envelope all leave the
 * world as they found it. The number comes from the first head-to-head
 * benchmark — every instance the loop resolved had edited a file well before
 * frame 15, and the instance it lost outright read for all 100 frames, made
 * 132 calls, attempted zero edits, and then claimed the fix was implemented.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultReadOnlyFrames = 12

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
  disciplineArmed: "flows.harness.discipline-armed.v1",
  cellCallSettled: "flows.harness.cell-call-settled.v1",
  cellCallStarted: "flows.harness.cell-call-started.v1",
  cellProduced: "flows.harness.cell-produced.v1",
  cellSettled: "flows.harness.cell-settled.v1",
  compactionSettled: "flows.harness.compaction-settled.v1",
  modelRetried: "flows.harness.model-retried.v1",
  readOnlyDemanded: "flows.harness.read-only-demanded.v1",
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
   * Consecutive read-only frames this run may spend before the controller
   * intervenes. Zero disarms the cap, which is what a conversational run gets.
   */
  readOnlyCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Frames settled since the last call that declared a write. */
  readOnlyFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Frames the demand stays silent for, bought by an accepted justification.
   *
   * A justification is an escape hatch with a price: it buys `readOnlyCap`
   * quiet frames and never resets {@link State.readOnlyFrames}, so a run that
   * keeps justifying still reaches the hard stop at twice the cap.
   */
  readOnlyGrace: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Intervention waiting to be resolved by the next frame. */
  pendingReadOnlyDemand: Schema.optional(Schema.Struct({
    streak: NonNegativeSafeInt,
    cap: NonNegativeSafeInt
  }))
}) {}

/**
 * Rebuilds controller state with only the fields one step changes.
 *
 * Every frame produces a whole new `State`, so a field added to the class had
 * to be threaded through five constructions by hand — and the one that was
 * forgotten silently reset a budget. Changes are stated; everything else is
 * carried.
 */
const advance = (state: State, changes: Partial<ConstructorParameters<typeof State>[0]>): State =>
  new State({ ...state, ...changes })

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
   * Caps consecutive read-only frames: at the cap the controller demands an
   * edit or a typed justification, and at twice the cap the run stops as a
   * typed failure. Omitted or zero disarms it, which is what a run that is
   * only meant to read — a question, a review — should get.
   */
  readonly readOnlyCap?: number | undefined
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
    readOnlyCap: options.readOnlyCap ?? 0,
    readOnlyFrames: 0,
    readOnlyGrace: 0,
    pendingReadOnlyDemand: undefined
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
      // `CanonicalJson.stringify` above already rejected every value
      // `JSON.stringify` renders as `undefined`, so each member has a length.
      .map(([key, value]) => `- ${key} (${JSON.stringify(value).length} bytes)`)
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

const clip = (text: string, width: number): string => text.length > width ? `${text.slice(0, width - 1)}…` : text

/**
 * States, unambiguously, that a call this frame failed about itself.
 *
 * The whole defect this closes is that `exitCode: 1` reads the same whether the
 * bug reproduced or the command named a test that does not exist. The flow that
 * ran the command is the only party that can tell, so it says so in its result;
 * this turns that into a sentence the next frame cannot summarise away.
 */
const invalidProbeNotice = (
  calls: ReadonlyArray<{
    readonly flow: string
    readonly invalidProbe: { readonly reason: string; readonly message: string } | undefined
  }>
): string | undefined => {
  const lines = calls.flatMap((call) =>
    call.invalidProbe === undefined
      ? []
      : [`- ${call.flow} (${call.invalidProbe.reason}): ${call.invalidProbe.message}`]
  )
  if (lines.length === 0) return undefined
  return `Invalid probe — ${lines.length} call${
    lines.length === 1 ? "" : "s"
  } this frame failed about the command, not about the code:\n${
    lines.join("\n")
  }\nThat result is not a reproduction and is not a regression: it reads identically on a broken tree and on a fixed one, so it can neither prove the bug nor prove the repair. Repair the command before editing anything — find the real names first — and do not cite it in verify.`
}

const readOnlyDemand = (cap: number, frames: number): string =>
  `Read-only discipline — ${frames} consecutive frames have made no call that declares a write, and this run's read-only budget is ${cap}. The next cell must do one of two things: call a flow that writes (an edit, a write, a patch — reading, searching, and running read-only commands do not count), or return { intent: "continue", state, context, justification: "<why an edit is still impossible, and the exact call that will make one possible>" }. A justification is recorded and buys ${cap} quiet frames; it does not reset this counter. At ${
    cap * 2
  } consecutive read-only frames the run stops as a failure, so ${
    cap * 2 - frames
  } frames remain in which to commit to a change.`

const readOnlyCapFailure = (cap: number, frames: number): HarnessError =>
  new HarnessError({
    code: "read_only_cap",
    message:
      `The run spent ${frames} consecutive frames without one call that declares a write, twice its read-only budget of ${cap}. It is stopped here rather than allowed to report work it never did.`
  })

/**
 * Whether one resolved call changes anything outside the run.
 *
 * Classification happens at the call boundary and reads declarations, not
 * flow names: a call mutates when its resolved descriptor declares writes, or
 * when the invocation itself declares them — which is how a shell flow whose
 * registry-time envelope is the conservative empty set still counts when the
 * cell declares what the command writes. `Forensics` classifies the same
 * events after the fact by name; the loop cannot, because a host catalog is
 * whatever the host bound.
 */
const mutating = (descriptor: Descriptor.FlowDescriptor, input: Schema.Json): boolean => {
  if (descriptor.effects.writes.length > 0) return true
  const declared = input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).writes
    : undefined
  return Array.isArray(declared) && declared.length > 0
}

const emitModelProgress = (
  event: ModelEvent.ModelEvent,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<void> =>
  event.type === "retry"
    ? emit(
      new AgentEvent.ModelRetried({
        eventType: eventType.modelRetried,
        attempt: event.attempt,
        code: event.code
      })
    )
    : event.type === "settle"
    ? Effect.void
    : emit(new AgentEvent.ModelDelta({ eventType: eventType.modelDelta, delta: event }))

/**
 * The reserved key a flow reports an invalid probe under.
 *
 * This is the one convention the loop reads off an otherwise opaque call
 * result. It is not a shared type — the controller must not depend on the tool
 * library — so it is a documented wire key. `@smthrs/std/Probe` is the
 * producing half and owns the taxonomy; the controller only has to know that a
 * result carrying this key is a result whose failure was about the command.
 */
const invalidProbeKey = "invalidProbe"

/** What a settled call declared about whether it ran a check at all. */
const invalidProbeOf = (
  value: Schema.Json
): { readonly reason: string; readonly message: string } | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const declared = (value as Record<string, unknown>)[invalidProbeKey]
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return undefined
  const { message, reason } = declared as Record<string, unknown>
  return typeof reason === "string" && typeof message === "string" ? { reason, message } : undefined
}

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
    // `InvalidStep` is discharged as a defect, not surfaced as a typed failure.
    // Every way to raise it is a prefix outside `[1, compactable.length]` or a
    // digest that disagrees with the declaration, and all three calls below are
    // handed the same immutable window plus `selectPrefix`'s own output on that
    // window. Raising it would mean compaction's prefix arithmetic contradicts
    // itself, which is a bug here rather than a condition a caller could act on.
    const step = yield* Compaction.declare(state.contextWindow, prefixLength, {
      identity: "flows/harness/CellTurn.compaction",
      modelId: modelIdFromSeat(state.seat),
      params: state.modelParams
    }).pipe(Effect.orDie)
    const summaryRequest = yield* Compaction.summaryRequest(state.contextWindow, step).pipe(Effect.orDie)
    const request = ModelRequest.ModelRequest.make({
      modelId: summaryRequest.modelId,
      system: summaryRequest.system,
      messages: summaryRequest.messages,
      tools: [],
      toolChoice: "none",
      params: summaryRequest.params
    })
    const events = yield* Stream.runCollect(
      engine.sealStep({ request, keyMaterial: keyMaterialFrom(state, request) }).pipe(
        Stream.tap((event) => emitModelProgress(event, emit))
      )
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
    const contextWindow = yield* Compaction.apply(state.contextWindow, step, summary).pipe(Effect.orDie)
    yield* emit(
      new AgentEvent.CompactionSettled({
        eventType: eventType.compactionSettled,
        replacedPrefixDigest: step.replacedPrefixDigest,
        summary
      })
    )
    return advance(state, { contextWindow })
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
    // Timed on the injected clock, never on ambient wall time, so a test that
    // supplies a clock sees the duration it declared.
    const startedAt = yield* Clock.currentTimeMillis
    const events = yield* Stream.runCollect(
      engine.sealStep({ request, keyMaterial: keyMaterialFrom(state, request) }).pipe(
        Stream.tap((event) => emitModelProgress(event, emit))
      )
    ).pipe(Effect.map((collected) => Array.from(collected)))
    const settledAt = yield* Clock.currentTimeMillis
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
        usage: settled.usage,
        durationMillis: settledAt - startedAt
      })
    )

    /** Records an unusable frame and asks for another, budget permitting. */
    const observe = (
      note: string,
      changes: Partial<ConstructorParameters<typeof State>[0]> = {}
    ): Step => {
      if (state.frame + 1 >= state.maxFrames) return { _tag: "Done" }
      return {
        _tag: "Continue",
        state: advance(state, {
          frame: state.frame + 1,
          contextWindow: observed(state, settled.message, note),
          ...changes
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
    const observedCalls: Array<{
      readonly flow: string
      readonly ok: boolean
      readonly summary: string
      /** Whether the call declared a write, which is what breaks a read-only run. */
      readonly mutates: boolean
      /** What the flow said about its own failure, when it said it ran nothing. */
      readonly invalidProbe: { readonly reason: string; readonly message: string } | undefined
    }> = []
    const observing: Sandbox.Handler = (invocation) =>
      callHandler(state, cell, descriptors, engine, emit)(invocation).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const rendered = result.outcome === "success"
              ? JSON.stringify(result.value) ?? "null"
              : result.message ?? "failed"
            const descriptor = descriptors.get(invocation.flow)
            observedCalls.push({
              flow: invocation.flow,
              ok: result.outcome === "success",
              summary: clip(rendered, 400),
              mutates: descriptor !== undefined && mutating(descriptor, invocation.input),
              invalidProbe: result.outcome === "success" ? invalidProbeOf(result.value) : undefined
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

    // The frame's own record of what it did to the world, computed once and
    // carried out through every exit.
    const mutatingCalls = observedCalls.filter((call) => call.mutates).length
    // The frame's own broken probes, stated once and delivered through every
    // exit. A cell chooses the context its successor sees, so a frame that
    // summarised "the test still fails" would otherwise carry the wrong belief
    // forward with nothing to contradict it.
    const probeNotice = invalidProbeNotice(observedCalls)

    if (outcome._tag !== "settled") {
      if (state.pendingReadOnlyDemand !== undefined) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: mutatingCalls > 0 ? "write" : "read-only"
          })
        )
      }
      const salvage = observedCalls.length === 0
        ? ""
        : `\nCalls this cell already completed (their results are durable; use them instead of redoing the work):\n${
          observedCalls.map((call) => `- ${call.flow} -> ${call.ok ? "ok" : "FAILED"}: ${call.summary}`).join("\n")
        }`
      const alert = probeNotice === undefined ? "" : `\n\n${probeNotice}`
      const note = outcome._tag === "raised"
        ? `The cell threw ${outcome.name}: ${outcome.message}. Emit a corrected cell.${salvage}${alert}`
        : `${outcome.message}${salvage}${alert}`
      // A frame that never settled a transition does not advance the
      // read-only counter — it produced no decision to judge — but an edit it
      // did land before throwing still clears it.
      const step = observe(note, {
        pendingReadOnlyDemand: undefined,
        ...(mutatingCalls > 0 ? { readOnlyFrames: 0, readOnlyGrace: 0 } : {})
      })
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
      if (state.pendingReadOnlyDemand !== undefined) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: mutatingCalls > 0 ? "write" : "park"
          })
        )
      }
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

    // Read-only discipline, applied to every frame that settled a decision.
    // A park is exempt: waiting is not evasion, and a parked run is not
    // reporting anything as done.
    const cap = state.readOnlyCap
    const readOnly = mutatingCalls === 0
    const readOnlyFrames = readOnly ? state.readOnlyFrames + 1 : 0
    if (state.pendingReadOnlyDemand !== undefined) {
      yield* emit(
        new AgentEvent.ReadOnlyDemanded({
          eventType: eventType.readOnlyDemanded,
          streak: state.pendingReadOnlyDemand.streak,
          cap: state.pendingReadOnlyDemand.cap,
          nextFrame: state.frame,
          nextAction: mutatingCalls > 0
            ? "write"
            : (transition._tag === "continue" && (transition.justification ?? "").trim().length > 0)
            ? "justification"
            : "read-only"
        })
      )
    }
    if (cap > 0 && readOnlyFrames >= cap * 2) {
      return yield* readOnlyCapFailure(cap, readOnlyFrames)
    }

    if (transition._tag === "complete") {
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
    // The intervention. At the cap the next frame is told, structurally, that
    // it must write something or say why it cannot; a justification is typed
    // data on the transition, is recorded, and buys a bounded quiet spell
    // without resetting the counter that ends the run at twice the cap.
    const graceLeft = readOnly ? state.readOnlyGrace : 0
    const demanded = cap > 0 && readOnly && readOnlyFrames >= cap && graceLeft === 0
    const justified = demanded && (transition.justification ?? "").trim().length > 0
    const readOnlyGrace = justified ? cap : Math.max(0, graceLeft - 1)
    const demand = demanded && !justified
      ? [ModelRequest.Message.user(readOnlyDemand(cap, readOnlyFrames))]
      : []
    const alerts = probeNotice === undefined ? [] : [ModelRequest.Message.user(probeNotice)]
    const context = projected(state, transition.context, [...drained.inserts, ...alerts, ...demand])
    return {
      _tag: "Continue",
      state: advance(state, {
        frame: state.frame + 1,
        seat,
        modelParams,
        contextWindow: seat === state.seat ? context : ContextWindow.make({
          modelId: modelIdFromSeat(seat),
          segments: context.segments,
          activeTools: context.activeTools,
          replaced: context.replaced
        }),
        agentState: transition.state,
        readOnlyFrames,
        readOnlyGrace,
        pendingReadOnlyDemand: demanded && !justified ? { streak: readOnlyFrames, cap } : undefined
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
      // Once, and only on a run's own first frame: a resumed run replays its
      // arming from the journal it already wrote, and a second record would
      // make the gate count runs instead of arming decisions.
      if (current.frame === 0) {
        const limits = Sandbox.withDefaults(sandbox.capabilities, input.limits)
        yield* emit(
          new AgentEvent.DisciplineArmed({
            eventType: eventType.disciplineArmed,
            readOnlyCap: current.readOnlyCap,
            maxFrames: current.maxFrames,
            ...limits
          })
        )
      }
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
