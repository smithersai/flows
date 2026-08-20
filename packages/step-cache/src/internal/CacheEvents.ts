/**
 * The reserved `flows.cache.*` event vocabulary behind the step cache's
 * tables.
 *
 * Governing design: `docs/specs/Concepts/Step Cache Fold.md`. The store's SQL
 * layer appends these events in the same `DurableWriter` transaction as every
 * row change, and `Fold` rebuilds both tables from them. Consumers of a run's
 * stream select this namespace by prefix and must not assume the stream
 * carries only their own events.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Schema from "effect/Schema"

/**
 * The event a `put` appends when and only when a table changed.
 *
 * @category constants
 * @since 0.1.0
 */
export const recordedEventType = "flows.cache.recorded"

/**
 * The event an `evict` appends when a head row was actually deleted.
 *
 * @category constants
 * @since 0.1.0
 */
export const evictedEventType = "flows.cache.evicted"

/**
 * The administrative state assertion the fold migration backfills per
 * pre-fold row, and journal compaction uses as the fold's checkpoint.
 *
 * @category constants
 * @since 0.1.0
 */
export const snapshotEventType = "flows.cache.snapshot"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * The durable data recorded for a cache key — the column set both tables
 * share, and the payload of a `flows.cache.recorded` event.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Entry = Schema.Struct({
  keyDigest: Schema.NonEmptyString,
  result: Schema.Unknown,
  meta: Schema.Unknown,
  createdAtMs: NonNegativeSafeInt,
  recordedRunId: Schema.NonEmptyString,
  recordedEventSeq: NonNegativeSafeInt
})

/**
 * The durable data recorded for a cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type

/**
 * Payload of a `flows.cache.evicted` event: the key plus the deleted row's
 * provenance, so a rebuild deletes exactly the generation the live DELETE
 * deleted and never a fresher one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const EvictedPayload = Schema.Struct({
  keyDigest: Schema.NonEmptyString,
  recordedRunId: Schema.NonEmptyString,
  recordedEventSeq: NonNegativeSafeInt
})

/**
 * Payload of a `flows.cache.evicted` event.
 *
 * @category models
 * @since 0.1.0
 */
export type EvictedPayload = typeof EvictedPayload.Type

/**
 * Payload of a `flows.cache.snapshot` event: which table the asserted row
 * belongs to, plus the full column set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SnapshotPayload = Schema.Struct({
  table: Schema.Literals(["head", "recorded"]),
  ...Entry.fields
})

/**
 * Payload of a `flows.cache.snapshot` event.
 *
 * @category models
 * @since 0.1.0
 */
export type SnapshotPayload = typeof SnapshotPayload.Type

/**
 * The producer identity of every event about one recorded generation: the
 * ledger triple `(keyDigest, recordedRunId, recordedEventSeq)`.
 *
 * Length prefixes preserve tuple boundaries, exactly as `makeEventId` does.
 * One identity's successive assertions — record, evict, an identical
 * re-record after the eviction — take successive `sourceSeq`, which is what
 * keeps a re-record whose content equals an evicted generation from
 * collapsing into a duplicate of the original append (issues #129/#164 in the
 * evict-then-identical-re-record path).
 *
 * @category constructors
 * @since 0.1.0
 */
export const sourceId = (keyDigest: string, recordedRunId: string, recordedEventSeq: number): string =>
  `flows:cache:${keyDigest.length}:${keyDigest}${recordedRunId.length}:${recordedRunId}${recordedEventSeq}`

/**
 * The run-root journal lineage every cache event carries in `meta.lineageId`.
 *
 * The store addresses entries by key digest and knows no node path, so the
 * lineage is the recording run's root — the `docs/specs/Concepts/Subflows.md`
 * lineage-id definition with an empty node path. An entry that belongs to no
 * lineage is not admissible (`docs/specs/Concepts/Journal Consensus.md`,
 * stage 1 round 3).
 *
 * @category constructors
 * @since 0.1.0
 */
export const lineageId = (runId: string): string => `${runId}/root`

const event = (
  runId: string,
  sourceId: string,
  eventType: string,
  payload: unknown
): JournalEvent.Input =>
  new JournalEvent.Input({
    runId: runId as JournalEvent.RunId,
    sourceId: sourceId as JournalEvent.SourceId,
    // `sourceSeq` is deliberately omitted: the journal allocates the producer
    // identity's next sequence, so successive assertions never collapse into
    // a `Duplicate` of an earlier generation's append.
    eventType,
    payload,
    meta: { lineageId: lineageId(runId) }
  })

/**
 * The `flows.cache.recorded` event for an admitted entry. Unfenced: cache
 * admission is content-address first-writer-wins, not run ownership.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recorded = (entry: Entry): JournalEvent.Input =>
  event(
    entry.recordedRunId,
    sourceId(entry.keyDigest, entry.recordedRunId, entry.recordedEventSeq),
    recordedEventType,
    entry
  )

/**
 * The `flows.cache.evicted` event for a deleted head row, appended under the
 * deleted row's recorded run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const evicted = (payload: EvictedPayload): JournalEvent.Input =>
  event(
    payload.recordedRunId,
    sourceId(payload.keyDigest, payload.recordedRunId, payload.recordedEventSeq),
    evictedEventType,
    payload
  )
