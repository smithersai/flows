/**
 * Serializable events emitted by harness adapters.
 *
 * @since 0.1.0
 */
import * as Permission from "@smthrs/capability-next/Permission"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Schema } from "effect"
import * as Cell from "./Cell.ts"
import * as EngineLike from "./EngineLike.ts"
import * as Plan from "./Plan.ts"

/**
 * The serializable snapshot fixed when a turn opens.
 *
 * @category events
 * @since 0.1.0
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
 */
export class ModelDelta extends Schema.TaggedClass<ModelDelta>(
  "flows/harness/AgentEvent/ModelDelta"
)("model-delta", {
  eventType: Schema.Literal("flows.harness.model-delta.v1"),
  delta: ModelEvent.ModelEvent
}) {}

/**
 * The complete recorded model settlement and usage.
 *
 * @category events
 * @since 0.1.0
 */
export class ModelSettled extends Schema.TaggedClass<ModelSettled>(
  "flows/harness/AgentEvent/ModelSettled"
)("model-settled", {
  eventType: Schema.Literal("flows.harness.model-settled.v1"),
  message: ModelRequest.AssistantMessage,
  usage: ModelEvent.Usage
}) {}

/**
 * A model settlement elaborated into a local plan batch.
 *
 * @category events
 * @since 0.1.0
 */
export class Elaborated extends Schema.TaggedClass<Elaborated>(
  "flows/harness/AgentEvent/Elaborated"
)("elaborated", {
  eventType: Schema.Literal("flows.harness.elaborated.v1"),
  batch: Plan.Batch
}) {}

/**
 * One settled child result returned by the engine.
 *
 * @category events
 * @since 0.1.0
 */
export class ChildResult extends Schema.TaggedClass<ChildResult>(
  "flows/harness/AgentEvent/ChildResult"
)("child-result", {
  eventType: Schema.Literal("flows.harness.child-result.v1"),
  result: Plan.ChildResult
}) {}

/**
 * One transient progress update from an executing child call.
 *
 * @category events
 * @since 0.1.0
 */
export class ChildProgress extends Schema.TaggedClass<ChildProgress>(
  "flows/harness/AgentEvent/ChildProgress"
)("child-progress", {
  eventType: Schema.Literal("flows.harness.child-progress.v1"),
  progress: Plan.ChildProgress
}) {}

/**
 * The cell source recovered from one model settlement.
 *
 * The source itself is durable evidence: replay re-executes exactly this text,
 * and every call identity inside the frame folds in its digest.
 *
 * @category events
 * @since 0.1.0
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
 */
export class TransitionApplied extends Schema.TaggedClass<TransitionApplied>(
  "flows/harness/AgentEvent/TransitionApplied"
)("transition-applied", {
  eventType: Schema.Literal("flows.harness.transition-applied.v1"),
  transition: Cell.Transition
}) {}

/**
 * The durable reason a cell execution parked.
 *
 * @category events
 * @since 0.1.0
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
 */
export class PermissionRequired extends Schema.TaggedClass<PermissionRequired>(
  "flows/harness/AgentEvent/PermissionRequired"
)("permission-required", {
  eventType: Schema.Literal("flows.harness.permission-required.v1"),
  request: Permission.PermissionRequired
}) {}

/**
 * Opaque resume carry-over reported by a harness adapter.
 *
 * The token is not key material. `discardResumeSession` is a poison-pill
 * report for the engine to enforce; the harness event does not enforce it.
 *
 * @category events
 * @since 0.1.0
 */
export class ResumeToken extends Schema.TaggedClass<ResumeToken>(
  "flows/harness/AgentEvent/ResumeToken"
)("resume-token", {
  eventType: Schema.Literal("flows.harness.resume-token.v1"),
  agentEngine: Schema.String,
  agentResume: Schema.String,
  discardResumeSession: Schema.Boolean
}) {}

/**
 * A normalized harness abort.
 *
 * @category events
 * @since 0.1.0
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
 */
export const AgentEvent = Schema.Union([
  TurnOpened,
  ModelDelta,
  ModelSettled,
  Elaborated,
  ChildProgress,
  ChildResult,
  CellProduced,
  CellCallStarted,
  CellCallSettled,
  CellSettled,
  TransitionApplied,
  Suspended,
  CompactionSettled,
  SteeringDrained,
  TurnClosed,
  PermissionRequired,
  ResumeToken,
  Aborted,
  Resolved
]).pipe(Schema.toTaggedUnion("_tag"))

/**
 * All normalized events emitted by a harness adapter.
 *
 * @category events
 * @since 0.1.0
 */
export type AgentEvent = typeof AgentEvent.Type
