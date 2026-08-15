/**
 * Stable, schema-backed control-plane failures.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect"
import { FlowId, RunId } from "./ControlSchema.ts"

const constantCode = <const Code extends string>(code: Code) =>
  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)))

/** @since 0.1.0 @category errors */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("/control/RunNotFound", {
  code: constantCode("run_not_found"),
  runId: RunId
}) {}

/** @since 0.1.0 @category errors */
export class FlowNotFound extends Schema.TaggedError<FlowNotFound>()("/control/FlowNotFound", {
  code: constantCode("flow_not_found"),
  flowId: FlowId
}) {}

/** @since 0.1.0 @category errors */
export class PlanDigestMismatch extends Schema.TaggedError<PlanDigestMismatch>()("/control/PlanDigestMismatch", {
  code: constantCode("plan_digest_mismatch"),
  planId: Schema.String,
  expected: Schema.String,
  actual: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class EnvelopeMismatch extends Schema.TaggedError<EnvelopeMismatch>()("/control/EnvelopeMismatch", {
  code: constantCode("envelope_mismatch"),
  planId: Schema.String,
  expected: Schema.String,
  actual: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class NotOwner extends Schema.TaggedError<NotOwner>()("/control/NotOwner", {
  code: constantCode("not_owner"),
  runId: RunId,
  ownerId: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class ClaimLost extends Schema.TaggedError<ClaimLost>()("/control/ClaimLost", {
  code: constantCode("claim_lost"),
  runId: RunId
}) {}

/** @since 0.1.0 @category errors */
export class AlreadyResolved extends Schema.TaggedError<AlreadyResolved>()("/control/AlreadyResolved", {
  code: constantCode("already_resolved"),
  requestId: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("/control/InvalidInput", {
  code: constantCode("invalid_input"),
  issue: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("/control/Unauthorized", {
  code: constantCode("unauthorized"),
  message: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class Unavailable extends Schema.TaggedError<Unavailable>()("/control/Unavailable", {
  code: constantCode("unavailable"),
  feature: Schema.String,
  ticket: Schema.String
}) {}

/** @since 0.1.0 @category errors */
export class TransportError extends Schema.TaggedError<TransportError>()("/control/TransportError", {
  code: constantCode("transport_error"),
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

/** @since 0.1.0 @category errors */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()("/control/PersistenceError", {
  code: constantCode("persistence_failed"),
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/** @since 0.1.0 @category errors */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("/control/LaunchFailed", {
  code: constantCode("launch_failed"),
  runId: RunId,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * A credential write lost a race: the record moved on before this writer
 * committed, so the update is refused rather than silently overwriting the
 * winner.
 *
 * @since 0.1.0
 * @category errors
 */
export class CredentialConflict extends Schema.TaggedError<CredentialConflict>()("/control/CredentialConflict", {
  code: constantCode("credential_conflict"),
  id: Schema.String,
  expectedVersion: Schema.Number,
  actualVersion: Schema.Number
}) {}

/**
 * Every stable failure emitted by the control plane.
 *
 * @since 0.1.0
 * @category errors
 */
export type ControlError =
  | RunNotFound
  | FlowNotFound
  | PlanDigestMismatch
  | EnvelopeMismatch
  | NotOwner
  | ClaimLost
  | AlreadyResolved
  | InvalidInput
  | Unauthorized
  | Unavailable
  | TransportError
  | PersistenceError
  | LaunchFailed
