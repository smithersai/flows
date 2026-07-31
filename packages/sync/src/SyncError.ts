/**
 * Stable, schema-backed failures for the sync boundary.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smithers/journal/JournalEvent"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

/**
 * Stable error codes returned by sync operations.
 *
 * @category models
 * @since 0.1.0
 */
export const ErrorCode = Schema.Literals([
  "invalid_request",
  "unauthorized",
  "not_found",
  "gap_detected",
  "backpressure",
  "frame_too_large",
  "decode_failed",
  "transport_failed",
  "protocol_violation",
  "optimistic_timeout",
  "closed",
  "unknown"
]).annotate({ identifier: "flows/sync/ErrorCode" })

/**
 * Stable error code returned by a sync operation.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised by sync validation, transport, framing, or subscription work.
 *
 * @category errors
 * @since 0.1.0
 */
export class SyncError extends Schema.TaggedErrorClass<SyncError>()("flows/sync/SyncError", {
  code: ErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {
  /**
   * Returns `true` when a value is a `SyncError`.
   *
   * @since 0.1.0
   */
  static readonly is = (value: unknown): value is SyncError => Predicate.isTagged(value, "flows/sync/SyncError")
}

/**
 * Terminal error raised when a server frame starts beyond the client's
 * covered cursor.
 *
 * @category errors
 * @since 0.1.0
 */
export class SyncGapError extends Schema.TaggedErrorClass<SyncGapError>()("flows/sync/SyncGapError", {
  runId: JournalEvent.RunId,
  expectedFrom: JournalEvent.Seq,
  receivedFrom: JournalEvent.Seq
}) {}
