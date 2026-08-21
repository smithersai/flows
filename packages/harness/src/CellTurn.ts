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
import * as Digest from "@smthrs/core/Digest"
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
import * as NarrowedCheck from "./NarrowedCheck.ts"
import * as Sandbox from "./Sandbox.ts"
import * as Steering from "./Steering.ts"
import * as TruncatedOutput from "./TruncatedOutput.ts"
import * as UnmovedTree from "./UnmovedTree.ts"
import * as UnresolvedFailure from "./UnresolvedFailure.ts"

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
 * Read-only means the frame left the workspace exactly as it found it —
 * measured, not declared; see {@link State.readOnlyFrames}. The number comes
 * from the first head-to-head benchmark — every instance the loop resolved had
 * edited a file well before frame 15, and the instance it lost outright read
 * for all 100 frames, made 132 calls, attempted zero edits, and then claimed
 * the fix was implemented.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultReadOnlyFrames = 12

/**
 * Default wall-clock milliseconds one model call may spend.
 *
 * The number is read off wave 7 of the SWE-bench harness, which journals
 * `durationMillis` for every sealed step. Its 68 model calls settled at a
 * median of 10.2 s, a p90 of 45.2 s, and a p95 of 110.6 s; the longest call
 * that produced a usable answer took 252.3 s (`django__django-16612`, an
 * instance that resolved), and the next longest 169.6 s. One call stood
 * outside that distribution entirely: 667.1 s on `pytest-dev__pytest-6197` —
 * 55% of the run's 1,200 s budget and 60,703 output tokens — for a cell that
 * raised on its first property access. Nothing capped it, because a model call
 * was the one thing the armed discipline did not bound.
 *
 * 300 s clears the longest answering call by 19% and every other call in the
 * wave by more than 2.6x, so the budget is not a latency target and does not
 * ration ordinary thinking; it is the ceiling that separates a slow answer
 * from a run spending half its wall clock on one. Under it the outlier is
 * interrupted at a quarter of the process budget instead of consuming
 * more than half of it, and the retry that follows costs a jittered second
 * rather than the whole run. 240 s would have cut off django's 252 s call, so
 * it is not the number the evidence supports.
 *
 * Zero disarms the budget, which is what a host that wants a model call
 * bounded by nothing but its own process must ask for explicitly.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultModelCallMs = 300_000

/**
 * Default number of consecutive repeat-observation frames a run may spend.
 *
 * A repeat-observation frame is one that issued at least one call, issued no
 * call this run had not already issued, and changed nothing. Such a frame buys
 * a model step and a flow call and is handed back what the run was already
 * holding.
 *
 * The number is read off wave 7 of the SWE-bench harness. Its one unresolved
 * instance made a real, surviving edit at frame 14 and then spent frames 15
 * through 24 re-reading that edit and re-running the same two check files —
 * ten frames that never revisited the mechanism, and the run died on its
 * process budget still confirming itself. Four is the smallest threshold an
 * ordinary re-check cannot reach: reading a file, editing it and reading it
 * back is one repeat frame, and running a check, reading the failure and
 * running it again is two. Four consecutive frames that learn nothing new is a
 * run that has stopped looking, not one double-checking its work.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultRepeatFrames = 4

/**
 * Default number of completions a run may have bounced for narrowed evidence.
 *
 * The demand is answered by acting, not by a counter, so the number is not a
 * budget to spend: it is how many times the loop will name a missing check
 * before it stops naming it. One is the whole design. The sanctioned shape for
 * this class of control is demand-then-continue — bounce once with an in-frame
 * observation, let the agent act, and take the next answer as it comes — which
 * is what the read-only cap and the repeat demand already do, and it is what
 * remains after the completion audit that re-ran commands from the harness was
 * removed on purpose. A second bounce would be the loop arguing with the run
 * about evidence it is not allowed to gather.
 *
 * The failure it answers is the tenth named failure mode of the SWE-bench cell
 * harness and the only one to decide the same instance in two consecutive waves
 * identically; see `NarrowedCheck` for the journal it was read off.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultNarrowingDemands = 1

/**
 * Default number of completions a run may have bounced for an unmoved tree.
 *
 * One, for the reason {@link defaultNarrowingDemands} is one: the sanctioned
 * shape for a control that judges a completion is demand-then-continue, and a
 * second bounce would be the loop arguing with the run.
 *
 * The failure it answers is the eleventh named failure mode of the SWE-bench
 * cell harness, and the only one where the harness held the deciding fact for
 * the whole run and never consulted it: seven frames of `mutation-observed` on
 * one digest, followed by a completion describing an edit that does not exist.
 * See `UnmovedTree` for the journal it was read off.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultUnmovedDemands = 1

/**
 * Default number of completions a run may have bounced for a failing check it
 * replaced rather than answered.
 *
 * One, for the same reason as the other two completion caps. See
 * `UnresolvedFailure` for the journal it was read off, and for why a failing
 * check on its own is not the trigger.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultUnresolvedDemands = 1

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
  repeatDemanded: "flows.harness.repeat-demanded.v1",
  narrowedDemanded: "flows.harness.narrowed-demanded.v1",
  unmovedDemanded: "flows.harness.unmoved-demanded.v1",
  unresolvedDemanded: "flows.harness.unresolved-demanded.v1",
  modelDelta: "flows.harness.model-delta.v1",
  modelSettled: "flows.harness.model-settled.v1",
  mutationObserved: "flows.harness.mutation-observed.v1",
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
  /**
   * Wall-clock milliseconds one model call may spend. Zero disarms the budget.
   *
   * Carried in controller state, and handed to the engine on every sealed
   * step, so the value journaled in `discipline-armed` is the value enforced.
   * See {@link defaultModelCallMs} for where the number comes from.
   */
  modelCallMs: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultModelCallMs)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultModelCallMs))
  ),
  /**
   * Frames settled since the last frame that changed the workspace.
   *
   * Changed-ness is measured as well as declared: the controller compares the
   * observation the previous frame closed on ({@link State.workspace}) against
   * the one this frame closes on, and a difference is a mutation whoever
   * performed it. The measurement is what a frame's calls cannot say; it is
   * never what overrules them. A frame is read-only when nothing declared a
   * write *and* no complete measurement saw one, because a measurement is
   * rooted, pruned and bounded, and the paths it does not cover are not
   * evidence that a run stopped working.
   *
   * It used to count frames since the last call that *declared* a write, and
   * the difference is not academic. `bash` declares no write set at all — its
   * registry envelope is the conservative empty one and an unhermetic
   * invocation carries no `writes` key, because a shell command's effects do
   * not travel through any boundary the harness can read. On the SWE-bench
   * pytest instance a frame ran `git show <base>:src/_pytest/python.py >
   * src/_pytest/python.py`, destroyed the fix the run had landed six frames
   * earlier, and was counted as read-only; the whole wave made 41 shell calls
   * and not one of them declared a write, so nothing in the harness saw a
   * single one of them.
   *
   * Declared writes are still what the capability envelope is enforced
   * against, still what decides whether the truncated-write refusal applies to
   * a call, still enough on their own to clear this counter, and still
   * journaled beside the measured answer as `declaredWrites`. This is
   * accounting, not permission. A host that measures nothing, or measures only
   * a prefix of its tree, keeps the old rule, and `MutationObserved.basis`
   * says which.
   */
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
  })),
  /**
   * Consecutive repeat-observation frames this run may spend before the
   * controller redirects it. Zero disarms the demand.
   *
   * Armed separately from {@link State.readOnlyCap} because the two answer
   * different stalls. The read-only cap watches a run that has written
   * nothing; this watches a run that has written something and keeps
   * confirming it. A run can be in both states at once, and telling one that
   * has already edited to "land an edit" sends it back to the file it is
   * already staring at.
   */
  repeatCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultRepeatFrames)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultRepeatFrames))
  ),
  /**
   * Consecutive frames that observed only what this run had already observed.
   *
   * A frame counts when it issued at least one call, issued no call whose
   * signature this run had not already issued, and changed nothing. A frame
   * that issued no call is neither a repeat nor a break: it made no
   * observation, so the counter is carried across it rather than advanced or
   * cleared — a run that thinks for a frame between two identical commands has
   * not stopped repeating itself, and a run planning its next move has not
   * started.
   */
  repeatFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Signatures of the calls this run has issued, oldest first.
   *
   * State rather than a per-frame detail because repetition is a property of
   * the run: the frame that re-runs a check is usually nowhere near the frame
   * that first ran it. It carries digests and no inputs; see
   * {@link signatureOf}.
   */
  callSignatures: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Completions this run may have bounced for narrowed evidence. Zero disarms
   * the demand.
   *
   * Armed separately from every other cap because it watches a different
   * moment. The read-only cap and the repeat demand watch a run that is still
   * working and has stopped making progress; this watches the one frame a run
   * gets wrong for free — the last one, where a narrowed check is presented as
   * evidence for a change it never covered. See {@link defaultNarrowingDemands}.
   */
  narrowingCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultNarrowingDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultNarrowingDemands))
  ),
  /**
   * Completions this run has already had bounced for narrowed evidence.
   *
   * Counted rather than flagged so the cap reads like the others, and carried
   * in state so a bounce survives the frame that answers it: the run stays
   * responsible for the answer, and the loop stops asking once it has asked.
   */
  narrowingDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for an unmoved tree. Zero disarms
   * the demand. See {@link defaultUnmovedDemands} and `UnmovedTree`.
   */
  unmovedCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultUnmovedDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultUnmovedDemands))
  ),
  /** Completions this run has already had bounced for an unmoved tree. */
  unmovedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for a failing check it replaced
   * rather than answered. Zero disarms the demand. See
   * {@link defaultUnresolvedDemands} and `UnresolvedFailure`.
   */
  unresolvedCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultUnresolvedDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultUnresolvedDemands))
  ),
  /** Completions this run has already had bounced for such a check. */
  unresolvedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Content address of the workspace this run opened on.
   *
   * Recorded once, from the first frame whose opening measurement covered the
   * tree, and never restamped: the whole question `UnmovedTree` asks is whether
   * the tree a completion describes is the tree the run was handed, and an
   * origin that moved with the run could not answer it. Empty means no frame
   * has produced a complete opening measurement, which makes the demand inert
   * rather than wrong.
   */
  openingDigest: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  /**
   * Checks this run has run, oldest first, each stamped with the tree it ran
   * over.
   *
   * State rather than a per-frame detail for the same reason
   * {@link State.callSignatures} is: the frame that narrows a check is nowhere
   * near the frame that first ran it. It carries the terms of each input rather
   * than the input, and only for calls that declared no write — a call that
   * changes the workspace is not an observation of it. See `NarrowedCheck`.
   */
  checks: NarrowedCheck.Ledger,
  /**
   * The output of the completion a completion demand handed back, if any.
   *
   * The demand takes a finished answer away and asks for one more frame. It is
   * allowed to do that only because the run gets to answer again — so the one
   * outcome it must never produce is a run that ends holding nothing. Between
   * the bounce and the next completion the run can spend its last frame on a
   * cell that raises, on a refused park, or on more work, and every one of
   * those ends the run on {@link budgetMessage} rather than on a completion.
   * Keeping the bounced output here is what makes the demand recoverable: the
   * budget still ends the run, and the run's own words are still what it ends
   * with. See `NarrowedCheck` for why the demand is issued at all.
   */
  bouncedCompletion: Schema.optional(Schema.String),
  /**
   * Whether a human can answer this run, which is what makes a park honorable.
   *
   * A park is durable waiting, and waiting only ends when somebody answers. A
   * run with no approval channel has nobody to answer it, so a park there is
   * not patience: it is the run abandoning a budget it still holds. False —
   * the default — refuses the transition and answers it in the frame that
   * returned it.
   */
  approvalChannel: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * The workspace as the last measured frame left it.
   *
   * Carried in state rather than re-measured because one measurement serves
   * two frames: what a frame closes on is what the next frame opens on, and
   * nothing between them touches the tree — the sealed model step in between
   * only produces text. So a run pays one walk per frame, not two, and a
   * resumed run replays the recorded measurement instead of walking a tree
   * that has moved on.
   *
   * Absent means no frame has measured yet; `None` means a frame measured and
   * the host reported it has nothing to measure. The two are kept apart so an
   * unobservable host is asked once and then left alone, instead of paying an
   * opening boundary every frame for an answer that will not change.
   */
  workspace: Schema.optional(Schema.Option(EngineLike.Observation)),
  /**
   * Output this run has been handed as a fragment, by digest.
   *
   * The ledger is state rather than a per-frame detail because a cell may store
   * a truncated capture and write it a frame later. It carries no bytes; see
   * `TruncatedOutput`.
   */
  truncatedOutputs: TruncatedOutput.Ledger
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
  /**
   * Caps the wall-clock one model call may spend, in milliseconds. Omitted
   * takes {@link defaultModelCallMs}; zero disarms the budget.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Caps consecutive repeat-observation frames: at the cap the controller
   * names the repetition and redirects the run at evidence it does not hold.
   * Omitted takes {@link defaultRepeatFrames}; zero disarms it.
   */
  readonly repeatCap?: number | undefined
  /**
   * Caps how many completions may be bounced for narrowed evidence: at the
   * first such completion the controller names the broader check the run has
   * not re-run since its latest change and asks for another frame. Omitted
   * takes {@link defaultNarrowingDemands}; zero disarms it.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Caps how many completions may be bounced for an unmoved tree: at the first
   * completion whose closing digest is the digest the run opened on, the
   * controller names both and asks for another frame. Omitted takes
   * {@link defaultUnmovedDemands}; zero disarms it.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Caps how many completions may be bounced for a failing check the run
   * replaced rather than answered. Omitted takes
   * {@link defaultUnresolvedDemands}; zero disarms it.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Whether a human can answer this run. Omitted or false refuses a `park`
   * transition and answers it in-frame; only a host that has wired somewhere
   * for an answer to come from may claim true.
   */
  readonly approvalChannel?: boolean | undefined
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
    modelCallMs: options.modelCallMs ?? defaultModelCallMs,
    readOnlyFrames: 0,
    readOnlyGrace: 0,
    pendingReadOnlyDemand: undefined,
    repeatCap: options.repeatCap ?? defaultRepeatFrames,
    repeatFrames: 0,
    callSignatures: [],
    narrowingCap: options.narrowingCap ?? defaultNarrowingDemands,
    narrowingDemands: 0,
    unmovedCap: options.unmovedCap ?? defaultUnmovedDemands,
    unmovedDemands: 0,
    unresolvedCap: options.unresolvedCap ?? defaultUnresolvedDemands,
    unresolvedDemands: 0,
    openingDigest: "",
    checks: [],
    approvalChannel: options.approvalChannel ?? false,
    workspace: undefined,
    truncatedOutputs: []
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
  }\nThat result is not a reproduction and is not a regression: it reads identically on a broken tree and on a fixed one, so it can neither prove the bug nor prove the repair. Repair the command before editing anything — find the real names first — and do not store it as \`state.verification\` or name it when you complete.`
}

/**
 * The intervention text, which asks for a decision and not for a keystroke.
 *
 * The first version of this said "write something". It was answered: on the
 * SWE-bench pytest instance the demanded frame ran `git show <base>:<path> >
 * <path>`, which satisfied nothing the cap is for and deleted the fix the run
 * had already landed. So the two ways out are stated as equals, the evidence a
 * real edit carries is named, and the writes that are worse than another quiet
 * frame are named too.
 */
const readOnlyDemand = (cap: number, frames: number): string =>
  `Read-only discipline — ${frames} consecutive frames have made no call that declares a write, and this run's read-only budget is ${cap}. The next cell must do one of two things, and they are equally acceptable: land an edit you can already name the evidence for — the file, the change, and the check you have watched fail that will now pass — or return { intent: "continue", state, context, justification: "<the evidence you are still missing, and the exact call that will get it>" }. Do not write something merely to answer this notice. A restore, a revert, an overwrite from captured output, or any edit whose evidence you cannot name is worse than another read-only frame, because it destroys work this run has already done. A justification is recorded and buys ${cap} quiet frames; it does not reset this counter. At ${
    cap * 2
  } consecutive read-only frames the run stops as a failure, so ${
    cap * 2 - frames
  } frames remain in which to commit to a change.`

/**
 * How many distinct call signatures one run carries forward.
 *
 * The ledger is durable controller state, so it is bounded. Sixty-four covers a
 * whole run at the rate a graded wave actually calls flows — its longest run
 * issued 43 calls across 24 frames — so a call is recognised as a repeat
 * however early the run first made it. A run that outlives the bound forgets
 * its oldest distinct calls first, which can cost a demand and can never
 * invent one.
 */
const retainedSignatures = 64

/**
 * The identity of one invocation: the flow it named and the input it passed.
 *
 * Digested rather than kept verbatim because an input is the whole of a shell
 * command and this list is journaled state. Two invocations share a signature
 * exactly when the cell asked for the same thing twice, which is the only
 * question the repeat demand asks. `Forensics` derives the same identity from
 * the journal after the fact; this is the loop's own view of it, available
 * while the run can still act on it.
 */
const signatureOf = (flow: string, input: Schema.Json): string => Digest.digest(CanonicalJson.stringify([flow, input]))

/**
 * Folds one frame's signatures into the run's ledger, newest last and bounded.
 *
 * A repeated signature moves to the newest position rather than taking a
 * second slot, so a run looping on one command cannot push everything it
 * learned earlier out of the ledger.
 */
const remember = (
  known: ReadonlyArray<string>,
  made: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const newest = new Set(known)
  for (const digest of made) {
    newest.delete(digest)
    newest.add(digest)
  }
  const distinct = [...newest]
  return distinct.slice(Math.max(0, distinct.length - retainedSignatures))
}

/**
 * The intervention that names a run's own repetition back to it.
 *
 * Separate text from the read-only demand because it is a different diagnosis
 * with a different way out. The read-only cap says nothing has been written and
 * asks for a change; this says the run keeps asking questions it has already
 * answered, and a run in this state has usually already written something. On
 * the SWE-bench pytest instance of wave 7 the run made a real, surviving edit
 * and then spent ten frames re-reading it — the diff, then the diff and the
 * status, then the status and the names, then the diff of the one file — and
 * re-running the same two check files, until the process budget ended it. The
 * text therefore does not ask for another edit. It states that the change is
 * real, that the failure is in the mechanism, and names the three places
 * evidence it does not hold actually lives.
 */
const repeatDemand = (frames: number, cap: number): string =>
  `Repeated observation — the last ${frames} frames issued only calls this run had already issued, byte for byte, and none of them changed the workspace. You are re-confirming what you already know: a call repeated over an unchanged tree returns what it returned the first time. If you have already made a change, it is real and it is recorded, and looking at it again cannot tell you whether it is the right change — what is left to establish is the mechanism, not the presence.

Spend the next frame on evidence you do not have. Three places hold some, and none of them is the diff:
- the failing check itself — what it asserts, the values it asserts about, and the setup that produces them;
- the history of the symbol you changed — \`git log -L <start>,<end>:<file>\` over its line range, or \`git blame\` on the line — which says why it is written the way it is and what it was written to handle;
- a different site — the callers of the symbol rather than its definition, which is where a wrong mechanism shows first.

If no call you can name would tell you something you do not already know, say which mechanism you now believe is wrong and change that instead. This notice returns after another ${cap} repeated frames.`

/**
 * The answer a park gets when nothing is listening for it.
 *
 * A park is a request for a human, and the run's own arming says whether one
 * exists. Refusing it is not an error the model has to repair — the frame is
 * ordinary, its state is kept, and the note states what is left to spend so the
 * next frame has no reason to read the refusal as "there is nothing more to
 * try". On the SWE-bench sphinx instance a run parked at frame 3 with 97
 * frames unspent, asking about a definition `grep` finds in the workspace it
 * was already holding.
 *
 * The frame it is answered in is an ordinary frame in every other respect,
 * read-only discipline included. Exempting it would hand a stalled run a way
 * out of the only control that ends a stall: a cell that parks every frame
 * would change nothing, be demanded nothing, and spend the whole frame budget
 * and the whole wall clock asking questions nobody is listening to.
 */
const parkRefusal = (
  message: string,
  framesLeft: number,
  frameSeconds: number | undefined
): string =>
  `No human is available: this run has no approval channel, so nobody can answer a park and the transition is not honored. What you asked — "${message}" — is now yours to settle. You have ${framesLeft} frame${
    framesLeft === 1 ? "" : "s"
  } left${
    frameSeconds === undefined ? "" : `, each able to spend up to ${frameSeconds} seconds`
  }, and the flows in ctx.flows to spend them on. Answer the question yourself with a call — search the workspace, read the file, run the command — and continue.`

const readOnlyCapFailure = (cap: number, frames: number): HarnessError =>
  new HarnessError({
    code: "read_only_cap",
    message:
      `The run spent ${frames} consecutive frames without one call that declares a write, twice its read-only budget of ${cap}. It is stopped here rather than allowed to report work it never did.`
  })

/**
 * Whether one resolved call *declares* that it changes something.
 *
 * Classification happens at the call boundary and reads declarations, not
 * flow names: a call declares a write when its resolved descriptor declares
 * writes, or when the invocation itself declares them — which is how a shell
 * flow whose registry-time envelope is the conservative empty set still counts
 * when the cell declares what the command writes. `Forensics` classifies the
 * same events after the fact by name; the loop cannot, because a host catalog
 * is whatever the host bound.
 *
 * This is a claim, not an observation, and the two are used for different
 * things. The claim decides authority — whether the truncated-write refusal
 * applies to this call — and the frame's *measured* change decides discipline.
 * A shell command that rewrites a tracked source file declares nothing and is
 * false here; it is still a mutation, and {@link witness} is what sees it.
 */
const mutating = (descriptor: Descriptor.FlowDescriptor, input: Schema.Json): boolean => {
  if (descriptor.effects.writes.length > 0) return true
  const declared = input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).writes
    : undefined
  return Array.isArray(declared) && declared.length > 0
}

/**
 * The schema one workspace measurement is journaled under.
 *
 * `Option` and not a bare struct because "the host measured nothing" is a
 * recorded answer in its own right: a replayed frame must be told that its
 * original attempt could not observe the tree, rather than inferring it from
 * an absent record and measuring a tree that has since moved.
 */
const RecordedObservation = Schema.Option(EngineLike.Observation)

/**
 * Measures the workspace once, through a journaled boundary.
 *
 * The measurement is a read of the world — the same class of thing as the
 * steering drain — so it goes through {@link EngineLike.EngineLike.record}
 * rather than being called directly. Left unjournaled, a resumed frame would
 * walk a tree that has moved on since the original attempt, compare it against
 * the recorded state of a different one, and invent a mutation nobody made.
 *
 * `phase` distinguishes the two measurements a frame can take. Only the first
 * frame of a run takes an opening one; every later frame opens on what its
 * predecessor closed with.
 */
const witness = (
  engine: EngineLike.EngineLike,
  state: State,
  boundary: string,
  phase: "open" | "close"
): Effect.Effect<Option.Option<EngineLike.Observation>, HarnessError> =>
  engine.record({
    name: `workspace-${phase}`,
    identity: { session: state.session, frame: state.frame, boundary },
    success: RecordedObservation,
    execute: engine.observe
  })

const emitModelProgress = (
  event: ModelEvent.ModelEvent,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<void> =>
  event.type === "retry"
    ? emit(
      new AgentEvent.ModelRetried({
        eventType: eventType.modelRetried,
        attempt: event.attempt,
        code: event.code,
        delayMillis: event.delayMillis
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

/**
 * What a run says when its frame budget, rather than the run, ended it.
 *
 * A run that never completed has only the budget to report. A run whose
 * completion was handed back for a narrowed verification has something else:
 * an answer it already gave, which the controller took away on the promise of
 * another frame. If that frame goes elsewhere — a cell that raises, a refused
 * park, more work than the budget has room for — the promise is the only thing
 * left, and dropping the answer would make the demand cost the run exactly the
 * thing it was meant to protect. Both facts are reported: the budget ended the
 * run, and this is what the run last said its answer was.
 */
const budgetMessage = (state: State): string =>
  state.bouncedCompletion === undefined
    ? `The frame budget of ${state.maxFrames} is exhausted. The run stops here; the last transition was a request to continue.`
    : `The frame budget of ${state.maxFrames} is exhausted. This run completed once and had that completion handed back for a narrowed verification, so what it reported then stands here rather than being lost:\n\n${state.bouncedCompletion}`

/**
 * Resolves one cell call into a durable engine boundary.
 *
 * Resolution happens here, at the boundary, and not inside the sandbox: the
 * flow must exist in the catalog this frame was given, and every capability it
 * declares must still be inside the run's narrowed envelope. Both denials are
 * ordinary call failures the cell can catch, which is what lets an agent
 * discover the shape of its authority without crashing the run.
 *
 * The truncation ledger is kept here for the same reason. The boundary is the
 * only party that sees both a result that declared its capture cut short and a
 * later call handing those exact bytes to something that writes, and a write of
 * a known fragment is refused rather than performed. See `TruncatedOutput`.
 *
 * `performed` collects the ordinal of every invocation that actually reached
 * the engine. The three refusals above return before it, and a refused call
 * changed nothing — so it must not read as a write to anything downstream. It
 * did once: the truncated-write refusal is the newest of the three and lands on
 * exactly the calls the read-only cap watches, so a run whose only edit was
 * refused had its read-only streak cleared by a write that never happened, and
 * the cap stayed silent through the stall it exists to break.
 */
const callHandler = (
  state: State,
  cell: Cell.Source,
  descriptors: ReadonlyMap<string, Descriptor.FlowDescriptor>,
  engine: EngineLike.EngineLike,
  ledger: Array<TruncatedOutput.Capture>,
  performed: Set<number>,
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
    // Only a call that changes something is checked. Passing a fragment to a
    // search, a diff, or a summary is ordinary use of what the flow returned;
    // handing it to something that writes is the one case that destroys a file.
    if (mutating(descriptor, invocation.input)) {
      const found = TruncatedOutput.reuse(invocation.input, ledger)
      if (found !== undefined) {
        return new Cell.CallResult({
          outcome: "failure",
          value: null,
          message: TruncatedOutput.refusal(invocation.flow, found)
        })
      }
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
    performed.add(invocation.ordinal)
    yield* emit(new AgentEvent.CellCallStarted({ eventType: eventType.cellCallStarted, call }))
    const result = yield* engine.call(call)
    if (result.outcome === "success") ledger.push(...TruncatedOutput.captures(call.flowName, result.value))
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
      engine.sealStep({
        request,
        keyMaterial: keyMaterialFrom(state, request),
        modelCallMs: state.modelCallMs
      }).pipe(
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
    // Seeded from what earlier frames were handed, appended to as this frame's
    // calls settle, and carried out through every exit that continues the run.
    const ledger: Array<TruncatedOutput.Capture> = [...state.truncatedOutputs]

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
      engine.sealStep({
        request,
        keyMaterial: keyMaterialFrom(state, request),
        modelCallMs: state.modelCallMs
      }).pipe(
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
          truncatedOutputs: TruncatedOutput.retain(ledger),
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
      // A rejected cell is the fourth exit that continues the run, and it is
      // judged by the same rule as the other three: no cell ran, so this frame
      // made no call and wrote nothing, and a frame that wrote nothing counts.
      // Leaving it frozen kept one shape of stall outside the only control
      // that ends one — a model that answers with prose instead of a cell
      // advanced no counter at all and spent the whole frame budget doing it.
      // Nothing to measure and nothing to demand: the cell never reached the
      // sandbox, so any pending demand is carried forward unanswered.
      const rejectedFrames = state.readOnlyFrames + 1
      if (state.readOnlyCap > 0 && rejectedFrames >= state.readOnlyCap * 2) {
        return yield* readOnlyCapFailure(state.readOnlyCap, rejectedFrames)
      }
      const step = observe(rejection.message, { readOnlyFrames: rejectedFrames })
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
      /**
       * Whether the call reached the engine declaring a write, which is what
       * breaks a read-only run. A call the boundary refused is not one: it
       * declared a write and performed none.
       */
      readonly mutates: boolean
      /** What this invocation asked for, as {@link signatureOf} names it. */
      readonly signature: string
      /** What this invocation asked for, verbatim, for the narrowing ledger. */
      readonly input: Schema.Json
      /** What the flow said about its own failure, when it said it ran nothing. */
      readonly invalidProbe: { readonly reason: string; readonly message: string } | undefined
      /**
       * Whether the result reported a failing exit status about its subject.
       *
       * A call that declared an invalid probe is never failing here, whatever
       * its exit status: the flow itself said the failure was about the command
       * and not about the code, so the result is not a statement about the tree
       * at all. See `UnresolvedFailure` `failed`.
       */
      readonly failing: boolean
    }> = []
    /** Ordinals of the invocations that reached the engine this frame. */
    const performed = new Set<number>()
    const observing: Sandbox.Handler = (invocation) =>
      callHandler(state, cell, descriptors, engine, ledger, performed, emit)(invocation).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const rendered = result.outcome === "success"
              ? JSON.stringify(result.value) ?? "null"
              : result.message ?? "failed"
            const descriptor = descriptors.get(invocation.flow)
            const probe = result.outcome === "success" ? invalidProbeOf(result.value) : undefined
            observedCalls.push({
              flow: invocation.flow,
              ok: result.outcome === "success",
              summary: clip(rendered, 400),
              mutates: performed.has(invocation.ordinal) && descriptor !== undefined &&
                mutating(descriptor, invocation.input),
              // Every invocation the cell issued, refused ones included: a
              // refusal is still a question the run has already asked, and
              // asking it again learns nothing either.
              signature: signatureOf(invocation.flow, invocation.input),
              input: invocation.input,
              invalidProbe: probe,
              failing: result.outcome === "success" && probe === undefined &&
                UnresolvedFailure.failed(result.value)
            })
          })
        )
      )
    // What the tree looked like before this frame's calls. Every frame after
    // the first opens on the measurement its predecessor closed with, so this
    // walks the workspace only when the run has none yet.
    const opened = state.workspace ?? (yield* witness(engine, state, cell.digest, "open"))
    const outcome = yield* sandbox.evaluate({
      cell,
      flows: projections,
      call: observing,
      state: state.agentState,
      limits: input.limits
    })
    const closed = yield* witness(engine, state, cell.digest, "close")
    yield* emit(
      new AgentEvent.CellSettled({ eventType: eventType.cellSettled, cell: cell.digest, outcome })
    )

    // The frame's own record of what it did to the world, computed once and
    // carried out through every exit.
    //
    // `declaredWrites` is what the frame's calls said about themselves and the
    // measurement is what the workspace says. A measurement adds a mutation
    // nothing declared — the shell redirect this exists for — and it does not
    // take away a declaration made by a call that *succeeded*, because it does
    // not cover the whole world: it stops at a bound, it prunes directories,
    // and it is rooted at one path, so a real edit outside what it covers
    // would read as an idle frame and twice the cap later the run would fail
    // as `read_only_cap` having edited files the whole time.
    //
    // A declaration made by a call that *failed* is a different claim. It says
    // what the call would have written, and a complete measurement that saw
    // the workspace hold still contradicts it directly rather than merely
    // failing to confirm it: nothing was written, so nothing was written
    // outside the bound either. Wave 7 recorded two such frames on one
    // instance — an anchor miss reporting `Failed to find expected lines`, and
    // an edit reporting `oldString does not occur` — each of which cleared a
    // read-only streak the run had not broken. Where the measurement is
    // partial or absent the old rule stands, because then the digest holding
    // still is not evidence of anything.
    const declaredWrites = observedCalls.filter((call) => call.mutates).length
    const measured = Option.isSome(opened) && Option.isSome(closed)
    const covered = measured && opened.value.complete && closed.value.complete
    const standingWrites = observedCalls.filter((call) => call.mutates && (call.ok || !covered)).length
    const mutated = standingWrites > 0 || (covered && opened.value.digest !== closed.value.digest)
    const closingDigest = Option.match(closed, { onNone: () => "", onSome: (value) => value.digest })
    yield* emit(
      new AgentEvent.MutationObserved({
        eventType: eventType.mutationObserved,
        basis: covered ? "observed" : measured ? "partial" : "declared",
        mutated,
        digest: closingDigest,
        paths: Option.match(closed, { onNone: () => 0, onSome: (value) => value.paths }),
        declaredWrites
      })
    )
    // The frame's own broken probes, stated once and delivered through every
    // exit. A cell chooses the context its successor sees, so a frame that
    // summarised "the test still fails" would otherwise carry the wrong belief
    // forward with nothing to contradict it.
    const probeNotice = invalidProbeNotice(observedCalls)

    // The frame's own repetition, measured the same way and carried the same
    // way: a frame repeats when it issued calls, issued none this run had not
    // already issued, and changed nothing. A signature the ledger has
    // forgotten reads as new, which delays a demand and never fabricates one.
    const signatures = observedCalls.map((call) => call.signature)
    const asked = new Set(state.callSignatures)
    const novel = signatures.some((signature) => !asked.has(signature))
    const callSignatures = remember(state.callSignatures, signatures)
    const repeatFrames = signatures.length === 0
      ? state.repeatFrames
      : novel || mutated
      ? 0
      : state.repeatFrames + 1

    // The frame's own checks, and the tree they were taken over.
    //
    // Only a call that succeeded and declared no write is a check: a failed
    // call observed nothing, and a call that changes the workspace is not an
    // observation of it. The digest is the frame's own closing measurement, and
    // only when that measurement covered the tree — under a partial or absent
    // one a moved digest is as likely to be a bound moving as work, and this
    // ledger's entire purpose is to say that the tree changed since a check
    // ran. An empty digest makes an entry inert rather than wrong.
    const workspaceDigest = covered ? closingDigest : ""
    const frameChecks = observedCalls.flatMap((call) => {
      if (!call.ok || call.mutates) return []
      const recorded = NarrowedCheck.check({
        flow: call.flow,
        signature: call.signature,
        input: call.input,
        digest: workspaceDigest,
        failing: call.failing,
        // A frame that also edited cannot say whether its checks ran before or
        // after the edit, so the tree stamped on them is a guess in one
        // direction. `UnresolvedFailure` refuses to carry a failure on such a
        // stamp; see `NarrowedCheck.Check` `stable`.
        stable: !mutated
      })
      return recorded === undefined ? [] : [recorded]
    })
    const checks = NarrowedCheck.remember(state.checks, frameChecks)

    // The tree the run was handed, fixed the first time a frame measured one
    // and never restamped. See `State.openingDigest`.
    const openingDigest = state.openingDigest !== ""
      ? state.openingDigest
      : Option.match(opened, {
        onNone: () => "",
        onSome: (value) => value.complete ? value.digest : ""
      })

    // Read-only discipline is armed for the whole frame, not for one exit: a
    // raise, a refused park and a settled transition all continue the run, and
    // each of them judges the frame by this cap.
    const cap = state.readOnlyCap

    if (outcome._tag !== "settled") {
      // The frame settled no transition, but it either changed the workspace
      // or it did not, and that is the whole of what the streak counts.
      // Freezing the counter here is how a stall hid from the cap: a run that
      // alternates a raise with a read advances the streak once every two
      // frames, so a cap of twelve took twenty-four frames to reach and a run
      // that raised more often than it read never reached it at all. Wave 7's
      // own report reads the drift the other way round — the journal's
      // mutation streak and this counter disagreed by one per raise — and the
      // instance that spent its whole budget raised twice.
      const raisedFrames = mutated ? 0 : state.readOnlyFrames + 1
      // A demand is answered by a write or by a justification, and a frame
      // that settled no transition produced neither. So a raise leaves the
      // demand pending — its text is still in the transcript this exit appends
      // to — and the journal names the frame that finally answers it.
      if (state.pendingReadOnlyDemand !== undefined && mutated) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: "write"
          })
        )
      }
      if (cap > 0 && raisedFrames >= cap * 2) {
        return yield* readOnlyCapFailure(cap, raisedFrames)
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
      const step = observe(note, {
        workspace: closed,
        readOnlyFrames: raisedFrames,
        repeatFrames,
        callSignatures,
        checks,
        openingDigest,
        ...(mutated ? { readOnlyGrace: 0, pendingReadOnlyDemand: undefined } : {})
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
            nextAction: mutated ? "write" : "park"
          })
        )
      }
      // A park with no channel to answer it is refused and answered here. The
      // journal states this without a event of its own: the pair
      // `transition-applied` carrying a `park` and `turn-closed` carrying
      // `continue` occurs for no other reason.
      if (!state.approvalChannel) {
        // A refused park continues the run, so its frame is judged like every
        // other continuing frame. Waiting was the exemption and there is no
        // waiting here: a cell that parks every frame changes nothing, and
        // without this it would be the one shape a stalled run can take that
        // the read-only cap never sees.
        const parkFrames = mutated ? 0 : state.readOnlyFrames + 1
        if (cap > 0 && parkFrames >= cap * 2) {
          return yield* readOnlyCapFailure(cap, parkFrames)
        }
        const limits = Sandbox.withDefaults(sandbox.capabilities, input.limits)
        const step = observe(
          parkRefusal(
            transition.message,
            Math.max(0, state.maxFrames - state.frame - 1),
            limits.totalMs === undefined ? undefined : Math.floor(limits.totalMs / 1000)
          ),
          {
            agentState: transition.state,
            pendingReadOnlyDemand: undefined,
            workspace: closed,
            readOnlyFrames: parkFrames,
            repeatFrames,
            callSignatures,
            checks,
            openingDigest,
            ...(mutated ? { readOnlyGrace: 0 } : {})
          }
        )
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
    // An honored park is exempt: waiting is not evasion, and a parked run is
    // not reporting anything as done. A refused park is not exempt — it
    // continues the run — and the branch above applies the same rule to it.
    const readOnly = !mutated
    const readOnlyFrames = readOnly ? state.readOnlyFrames + 1 : 0
    if (state.pendingReadOnlyDemand !== undefined) {
      yield* emit(
        new AgentEvent.ReadOnlyDemanded({
          eventType: eventType.readOnlyDemanded,
          streak: state.pendingReadOnlyDemand.streak,
          cap: state.pendingReadOnlyDemand.cap,
          nextFrame: state.frame,
          nextAction: mutated
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
      // The completion's own evidence, judged once per demand. A run gets
      // exactly one frame wrong for free — the last one — and three things can
      // be wrong with it, each read off measurements the controller already
      // took and each with its own cap:
      //
      // 1. `UnmovedTree`: the tree it is completing on is the tree it opened
      //    on, so there is no change for any evidence to be about;
      // 2. `UnresolvedFailure`: a check over this exact tree reported a failing
      //    exit status and the run answered it with a different reading of the
      //    same subject rather than with the check itself;
      // 3. `NarrowedCheck`: this frame's check repeats an earlier, broader one
      //    and adds conditions to it, run after a change the broader one never
      //    saw.
      //
      // At most one is named, in that order, because they are in descending
      // order of how fundamental the missing thing is: there is nothing to
      // check, then the check said no, then the check said less than it looks
      // like it said. Naming two at once would ask the run to answer a
      // question it has not been given a frame for.
      //
      // The loop names what is missing and hands the frame back; it does not
      // re-run anything, and it does not judge the answer that comes back. A
      // budget with no frame left to spend cannot ask, so it does not: turning
      // a completion into an exhausted budget would lose the run's answer to
      // make a point about it.
      const room = state.frame + 1 < state.maxFrames
      const unmoved = room && state.unmovedDemands < state.unmovedCap
        ? UnmovedTree.find({ opened: openingDigest, digest: workspaceDigest })
        : undefined
      const unresolved = unmoved === undefined && room && state.unresolvedDemands < state.unresolvedCap
        ? UnresolvedFailure.find({ ledger: checks, digest: workspaceDigest })
        : undefined
      const narrowing = unmoved === undefined && unresolved === undefined && room &&
          state.narrowingDemands < state.narrowingCap
        ? NarrowedCheck.find({ ledger: state.checks, frame: frameChecks, digest: workspaceDigest })
        : undefined
      if (unmoved !== undefined) {
        yield* emit(
          new AgentEvent.UnmovedDemanded({
            eventType: eventType.unmovedDemanded,
            openedDigest: unmoved.opened,
            currentDigest: unmoved.closed,
            nextFrame: state.frame + 1
          })
        )
      }
      if (unresolved !== undefined) {
        yield* emit(
          new AgentEvent.UnresolvedDemanded({
            eventType: eventType.unresolvedDemanded,
            flow: unresolved.failed.flow,
            failed: unresolved.failed.label,
            instead: unresolved.instead.label,
            currentDigest: workspaceDigest,
            nextFrame: state.frame + 1
          })
        )
      }
      if (narrowing !== undefined) {
        yield* emit(
          new AgentEvent.NarrowedDemanded({
            eventType: eventType.narrowedDemanded,
            flow: narrowing.earlier.flow,
            broader: narrowing.earlier.label,
            narrower: narrowing.later.label,
            broaderDigest: narrowing.earlier.digest,
            currentDigest: workspaceDigest,
            nextFrame: state.frame + 1
          })
        )
      }
      const demanded = unmoved !== undefined
        ? { note: UnmovedTree.demand(unmoved), spent: { unmovedDemands: state.unmovedDemands + 1 } }
        : unresolved !== undefined
        ? {
          note: UnresolvedFailure.demand(unresolved),
          spent: { unresolvedDemands: state.unresolvedDemands + 1 }
        }
        : narrowing !== undefined
        ? { note: NarrowedCheck.demand(narrowing), spent: { narrowingDemands: state.narrowingDemands + 1 } }
        : undefined
      if (demanded !== undefined) {
        yield* emit(
          new AgentEvent.TurnClosed({
            eventType: eventType.turnClosed,
            stopReason: settled.message.stopReason,
            outcome: "continue"
          })
        )
        return {
          _tag: "Continue",
          state: advance(state, {
            frame: state.frame + 1,
            // The demand is an in-frame observation appended to what the run
            // was already holding, not a projected context: a completion names
            // no context for a next frame, and a run answering this one needs
            // the frame it just wrote.
            contextWindow: observed(state, settled.message, demanded.note),
            agentState: transition.state,
            truncatedOutputs: TruncatedOutput.retain(ledger),
            workspace: closed,
            readOnlyFrames,
            pendingReadOnlyDemand: undefined,
            repeatFrames,
            callSignatures,
            checks,
            openingDigest,
            ...demanded.spent,
            // The answer the demand is taking away, kept so it cannot be lost.
            // A frame was reserved for the run to answer in, but nothing makes
            // that frame end in a completion, and a run that spends it and
            // then runs out of budget would end on the budget notice with its
            // own answer discarded. See {@link budgetMessage}.
            bouncedCompletion: transition.output,
            ...(mutated ? { readOnlyGrace: 0 } : {})
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
    // The convergence intervention. It is journaled when it is *issued* rather
    // than when the next frame answers it, because what answers it is the
    // shape of that frame's calls — which the journal already writes one by
    // one — and not a field on a transition the controller has to wait for.
    // Issuing it restarts the count, so a run that keeps repeating is told
    // once every `repeatCap` frames instead of every frame.
    const repeatDemanded = state.repeatCap > 0 && repeatFrames >= state.repeatCap
    if (repeatDemanded) {
      yield* emit(
        new AgentEvent.RepeatDemanded({
          eventType: eventType.repeatDemanded,
          frames: repeatFrames,
          cap: state.repeatCap,
          nextFrame: state.frame + 1
        })
      )
    }
    const repeated = repeatDemanded
      ? [ModelRequest.Message.user(repeatDemand(repeatFrames, state.repeatCap))]
      : []
    const alerts = probeNotice === undefined ? [] : [ModelRequest.Message.user(probeNotice)]
    const context = projected(state, transition.context, [
      ...drained.inserts,
      ...alerts,
      ...demand,
      ...repeated
    ])
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
        truncatedOutputs: TruncatedOutput.retain(ledger),
        workspace: closed,
        readOnlyFrames,
        readOnlyGrace,
        repeatFrames: repeatDemanded ? 0 : repeatFrames,
        callSignatures,
        checks,
        openingDigest,
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
            approvalChannel: current.approvalChannel,
            modelCallMs: current.modelCallMs,
            repeatCap: current.repeatCap,
            narrowingCap: current.narrowingCap,
            unmovedCap: current.unmovedCap,
            unresolvedCap: current.unresolvedCap,
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
