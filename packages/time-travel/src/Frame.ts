import * as Schema from "effect/Schema"

/** @since 0.1.0 @category schemas */
export const Frame = Schema.Struct({
  lineageId: Schema.NonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
/** @since 0.1.0 @category models */
export type Frame = typeof Frame.Type
/** @since 0.1.0 @category schemas */
export const LineageEdgeKind = Schema.Literals(["child", "fork", "continuation"])
/** @since 0.1.0 @category models */
export type LineageEdgeKind = typeof LineageEdgeKind.Type
/** @since 0.1.0 @category schemas */
export const LineageEdge = Schema.Struct({
  parentRunId: Schema.NonEmptyString,
  parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  childRunId: Schema.NonEmptyString,
  kind: LineageEdgeKind,
  attached: Schema.Boolean
})
/** @since 0.1.0 @category models */
export type LineageEdge = typeof LineageEdge.Type
/**
 * The journal event type marking a run as fork-created.
 *
 * `docs/specs/Concepts/Forensics.md` §68 asks a forked run to say so on its own
 * journal, so a cross-fork timeline can start from any child and walk back
 * without consulting the edge table. The record sits directly above the copied
 * prefix and carries `(parentRunId, forkJournalOffset)`.
 *
 * @since 0.1.0 @category constants
 */
export const forkCreatedEventType = "flows.time-travel.fork-created"
/** @since 0.1.0 @category schemas */
export const ForkCreated = Schema.Struct({
  parentRunId: Schema.NonEmptyString,
  forkJournalOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  childRunId: Schema.NonEmptyString
})
/** @since 0.1.0 @category models */
export type ForkCreated = typeof ForkCreated.Type
