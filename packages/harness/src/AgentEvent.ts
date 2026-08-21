/**
 * Serializable events emitted by harness adapters.
 *
 * @since 0.1.0
 */
import * as Permission from "@smthrs/capability/Permission"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Schema } from "effect"
import * as Cell from "./Cell.ts"
import * as EngineLike from "./EngineLike.ts"

/**
 * The loop discipline a run was armed with, journaled once when it starts.
 *
 * Arming used to be observable only through the events a disciplined run
 * *reaches*: the read-cap failure proves the cap was armed, and a run that
 * times out before it fires proves nothing — so a grader could not tell "armed
 * but never reached" from "never armed", which is exactly what the 2026-08-19
 * SWE-bench wave could not decide about its django instance. This event is the
 * positive record: it says what was armed, before anything has had a chance to
 * fire.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class DisciplineArmed extends Schema.TaggedClass<DisciplineArmed>(
  "flows/harness/AgentEvent/DisciplineArmed"
)("discipline-armed", {
  eventType: Schema.Literal("flows.harness.discipline-armed.v1"),
  /** Consecutive read-only frames allowed; zero means the cap is disarmed. */
  readOnlyCap: Schema.Number,
  /** The frame budget the run stops at. */
  maxFrames: Schema.Number,
  /**
   * Whether a human can answer this run.
   *
   * False says nothing is listening: a `park` transition is refused and
   * answered in the frame that returned it, because a run that waits for an
   * answer nobody will give has stopped working with its budget unspent.
   */
  approvalChannel: Schema.Boolean,
  /**
   * Wall-clock milliseconds one model call may spend; zero means disarmed.
   *
   * Every other budget here caps the cell — the calls it makes, the memory and
   * time its code spends, the run's frames. This one caps the step in between,
   * which was the only unbounded thing the loop did.
   */
  modelCallMs: Schema.Number,
  /** Maximum calls per cell, when this binding can enforce one. */
  calls: Schema.optional(Schema.Number),
  /** Maximum sandbox heap, when this binding can enforce one. */
  memoryBytes: Schema.optional(Schema.Number),
  /** Maximum interpreter steps, when this binding can enforce one. */
  steps: Schema.optional(Schema.Number),
  /** Maximum cell-compute time, when this binding can enforce one. */
  timeMs: Schema.optional(Schema.Number),
  /** Maximum whole-evaluation time, when this binding can enforce one. */
  totalMs: Schema.optional(Schema.Number),
  /** Maximum wall-clock time for one flow call. */
  callMs: Schema.optional(Schema.Number)
}) {}

/**
 * The serializable snapshot fixed when a turn opens.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TurnOpened extends Schema.TaggedClass<TurnOpened>(
  "flows/harness/AgentEvent/TurnOpened"
)("turn-opened", {
  eventType: Schema.Literal("flows.harness.turn-opened.v1"),
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  activeToolNames: Schema.Array(Schema.String),
  contextDigest: Schema.String
}) {}

/**
 * One provider-neutral model progress event.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class ModelDelta extends Schema.TaggedClass<ModelDelta>(
  "flows/harness/AgentEvent/ModelDelta"
)("model-delta", {
  eventType: Schema.Literal("flows.harness.model-delta.v1"),
  delta: ModelEvent.ModelEvent
}) {}

/**
 * A transport-only model retry taken before the sealed step settled.
 *
 * @category events
 * @since 0.1.0
 */
export class ModelRetried extends Schema.TaggedClass<ModelRetried>(
  "flows/harness/AgentEvent/ModelRetried"
)("model-retried", {
  eventType: Schema.Literal("flows.harness.model-retried.v1"),
  attempt: Schema.Int,
  code: Schema.String,
  /**
   * Milliseconds the boundary waited before this attempt.
   *
   * Every retry of one sealed step is journaled at the moment the step
   * settles, so the event timestamps cannot show the schedule. This carries
   * it. Zero is what an unscheduled retry, or a record written before the
   * field existed, reports.
   */
  delayMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
}) {}

/**
 * The complete recorded model settlement and usage.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class ModelSettled extends Schema.TaggedClass<ModelSettled>(
  "flows/harness/AgentEvent/ModelSettled"
)("model-settled", {
  eventType: Schema.Literal("flows.harness.model-settled.v1"),
  message: ModelRequest.AssistantMessage,
  usage: ModelEvent.Usage,
  /**
   * Wall-clock milliseconds the sealed step took, measured on the injected
   * clock.
   *
   * Usage alone answers what a call cost, never how long it took, so a
   * benchmark could compare tokens per run but not seconds per call — and
   * speed was the larger half of the gap the first head-to-head measured.
   * Zero is what an event carries when nothing timed it.
   */
  durationMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
}) {}

/**
 * The cell source recovered from one model settlement.
 *
 * The source itself is durable evidence: replay re-executes exactly this text,
 * and every call identity inside the frame folds in its digest.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellProduced extends Schema.TaggedClass<CellProduced>(
  "flows/harness/AgentEvent/CellProduced"
)("cell-produced", {
  eventType: Schema.Literal("flows.harness.cell-produced.v1"),
  cell: Cell.Source
}) {}

/**
 * One flow call opened from inside a running cell.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellCallStarted extends Schema.TaggedClass<CellCallStarted>(
  "flows/harness/AgentEvent/CellCallStarted"
)("cell-call-started", {
  eventType: Schema.Literal("flows.harness.cell-call-started.v1"),
  call: Cell.Call
}) {}

/**
 * One settled flow call made from inside a running cell.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellCallSettled extends Schema.TaggedClass<CellCallSettled>(
  "flows/harness/AgentEvent/CellCallSettled"
)("cell-call-settled", {
  eventType: Schema.Literal("flows.harness.cell-call-settled.v1"),
  flowName: Schema.String,
  identity: Cell.CallIdentity,
  result: Cell.CallResult
}) {}

/**
 * The outcome of executing one cell, whether it settled, threw, or was
 * rejected before it ran.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CellSettled extends Schema.TaggedClass<CellSettled>(
  "flows/harness/AgentEvent/CellSettled"
)("cell-settled", {
  eventType: Schema.Literal("flows.harness.cell-settled.v1"),
  cell: Schema.String,
  outcome: Cell.Outcome
}) {}

/**
 * The durable transition the controller applied after a cell settled.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TransitionApplied extends Schema.TaggedClass<TransitionApplied>(
  "flows/harness/AgentEvent/TransitionApplied"
)("transition-applied", {
  eventType: Schema.Literal("flows.harness.transition-applied.v1"),
  transition: Cell.Transition
}) {}

/**
 * The outcome of the frame immediately following a read-cap intervention.
 *
 * @category events
 * @since 0.1.0
 */
export class ReadOnlyDemanded extends Schema.TaggedClass<ReadOnlyDemanded>(
  "flows/harness/AgentEvent/ReadOnlyDemanded"
)("read-only-demanded", {
  eventType: Schema.Literal("flows.harness.read-only-demanded.v1"),
  streak: Schema.Int,
  cap: Schema.Int,
  nextFrame: Schema.Int,
  nextAction: Schema.Literals(["write", "justification", "read-only", "park"])
}) {}

/**
 * What one frame did to the workspace, and how the controller knows.
 *
 * Emitted once per frame that ran a cell. It is the frame's own answer to the
 * question every later audit asks — "did this frame change anything" — written
 * before any control acts on it, so a run that never trips the cap still leaves
 * the evidence behind.
 *
 * `basis` is the field that keeps the record honest. `observed` means the frame
 * had two measurements around it that each covered the whole workspace, so the
 * tree itself could answer. `partial` means a measurement was taken and stopped
 * at a bound before it covered the tree, so it is set aside: a prefix chosen by
 * sort order cannot say the files being edited outside it held still, and its
 * own movement is as likely to be a tool's churn as work. `declared` means the
 * host measured nothing at all.
 * Under the last two, `mutated` is only what the frame's calls claimed about
 * themselves — which is exactly the signal that missed a shell redirect over a
 * tracked source file.
 *
 * `mutated` is the union of the two signals and never the measurement alone: a
 * declared write stands even where the measurement cannot see the path it
 * touched, because the alternative is failing a run that has been editing all
 * along on the strength of a walk that never looked at its files.
 *
 * @category events
 * @since 0.1.0
 */
export class MutationObserved extends Schema.TaggedClass<MutationObserved>(
  "flows/harness/AgentEvent/MutationObserved"
)("mutation-observed", {
  eventType: Schema.Literal("flows.harness.mutation-observed.v1"),
  /** What the frame had to decide with: a full measurement, a partial one, or paperwork. */
  basis: Schema.Literals(["observed", "partial", "declared"]),
  /** Whether this frame changed anything: the tree said so, or a call declared it. */
  mutated: Schema.Boolean,
  /** Content address of the workspace as the frame left it; empty when unobserved. */
  digest: Schema.String,
  /** Paths the closing measurement covered; zero when unobserved. */
  paths: Schema.Int,
  /**
   * Calls this frame made that DECLARED a write.
   *
   * Journaled beside the observed answer rather than instead of it, because
   * the gap between the two numbers is the accounting defect itself: a frame
   * with `declaredWrites: 0` and `mutated: true` is a shell mutation nothing
   * else in the run can see.
   */
  declaredWrites: Schema.Int
}) {}

/**
 * The durable reason a cell execution parked.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Suspended extends Schema.TaggedClass<Suspended>(
  "flows/harness/AgentEvent/Suspended"
)("suspended", {
  eventType: Schema.Literal("flows.harness.suspended.v1"),
  reason: EngineLike.SuspendReason
}) {}

/**
 * A sealed compaction summary and the prefix it replaces.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class CompactionSettled extends Schema.TaggedClass<CompactionSettled>(
  "flows/harness/AgentEvent/CompactionSettled"
)("compaction-settled", {
  eventType: Schema.Literal("flows.harness.compaction-settled.v1"),
  replacedPrefixDigest: Schema.String,
  summary: ModelRequest.Message
}) {}

/**
 * Steering messages drained at a turn boundary.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class SteeringDrained extends Schema.TaggedClass<SteeringDrained>(
  "flows/harness/AgentEvent/SteeringDrained"
)("steering-drained", {
  eventType: Schema.Literal("flows.harness.steering-drained.v1"),
  messages: Schema.Array(ModelRequest.Message)
}) {}

/**
 * The terminal decision made at a turn boundary.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class TurnClosed extends Schema.TaggedClass<TurnClosed>(
  "flows/harness/AgentEvent/TurnClosed"
)("turn-closed", {
  eventType: Schema.Literal("flows.harness.turn-closed.v1"),
  stopReason: ModelRequest.StopReason,
  outcome: Schema.Literals(["continue", "resolved", "aborted", "suspended"])
}) {}

/**
 * A permission request reported for engine-owned suspension and resolution.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class PermissionRequired extends Schema.TaggedClass<PermissionRequired>(
  "flows/harness/AgentEvent/PermissionRequired"
)("permission-required", {
  eventType: Schema.Literal("flows.harness.permission-required.v1"),
  request: Permission.PermissionRequired
}) {}

/**
 * A normalized harness abort.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Aborted extends Schema.TaggedClass<Aborted>(
  "flows/harness/AgentEvent/Aborted"
)("aborted", {
  eventType: Schema.Literal("flows.harness.aborted.v1"),
  reason: Schema.String
}) {}

/**
 * The final assistant message produced by the harness.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export class Resolved extends Schema.TaggedClass<Resolved>(
  "flows/harness/AgentEvent/Resolved"
)("resolved", {
  eventType: Schema.Literal("flows.harness.resolved.v1"),
  message: ModelRequest.AssistantMessage
}) {}

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export const AgentEvent = Schema.Union([
  DisciplineArmed,
  TurnOpened,
  ModelDelta,
  ModelRetried,
  ModelSettled,
  CellProduced,
  CellCallStarted,
  CellCallSettled,
  CellSettled,
  TransitionApplied,
  MutationObserved,
  ReadOnlyDemanded,
  Suspended,
  CompactionSettled,
  SteeringDrained,
  TurnClosed,
  PermissionRequired,
  Aborted,
  Resolved
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 * @slop
 */
export type AgentEvent = typeof AgentEvent.Type
