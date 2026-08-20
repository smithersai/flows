/**
 * The step cache as a fold of journal events.
 *
 * `flows_step_cache` and `flows_step_cache_recorded` are rebuildable
 * materializations of the reserved `flows.cache.*` namespace: forward writes
 * append the event and write the row in one transaction (`CacheStore`), and
 * this module recomputes the tables from the retained journal. There is no
 * third way to write them. The invariant is *retained*: a cache may forget —
 * compaction that drops a key's recorded events without a snapshot makes the
 * rebuilt cache miss that key, and a miss is the correct answer for an
 * evicted cache entry.
 *
 * Governing design: `docs/specs/Concepts/Step Cache Fold.md`. Prior art:
 * bazel Skyframe's derived state recomputable from primary inputs
 * (`reference/bazel`), and temporal's mutable state rebuilt by replaying
 * history (`reference/temporal`).
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Projection from "@smthrs/journal/Projection"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type CacheEntry, CacheStoreError, encodeCanonical } from "./CacheStore.ts"
import * as CacheEvents from "./internal/CacheEvents.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * The `flows.cache.*` event-type prefix. A consumer that projects one channel
 * out of a run's stream selects by namespace and must not assume the stream
 * carries only its own events.
 *
 * @category constants
 * @since 0.1.0
 */
export const namespace = "flows.cache."

/**
 * The head materialization: key digest to the entry `get` serves.
 *
 * @category models
 * @since 0.1.0
 */
export type HeadState = ReadonlyMap<string, CacheEntry>

/**
 * The ledger materialization, keyed by {@link tripleKey}.
 *
 * @category models
 * @since 0.1.0
 */
export type LedgerState = ReadonlyMap<string, CacheEntry>

/**
 * The map key of one recorded generation: the ledger triple
 * `(keyDigest, recordedRunId, recordedEventSeq)`, length-prefixed so tuple
 * boundaries survive identifiers containing the separator.
 *
 * @category constructors
 * @since 0.1.0
 */
export const tripleKey = (keyDigest: string, recordedRunId: string, recordedEventSeq: number): string =>
  CacheEvents.sourceId(keyDigest, recordedRunId, recordedEventSeq)

const decodeFailed = (message: string, cause: unknown): CacheStoreError =>
  new CacheStoreError({ code: "decode_failed", message, cause })

const decodeEntryPayload = (payload: unknown): Effect.Effect<CacheEntry, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheEvents.Entry)(payload).pipe(
    Effect.mapError((cause) => decodeFailed(`could not decode a ${CacheEvents.recordedEventType} payload`, cause))
  )

const decodeEvictedPayload = (payload: unknown): Effect.Effect<CacheEvents.EvictedPayload, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheEvents.EvictedPayload)(payload).pipe(
    Effect.mapError((cause) => decodeFailed(`could not decode a ${CacheEvents.evictedEventType} payload`, cause))
  )

const decodeSnapshotPayload = (payload: unknown): Effect.Effect<CacheEvents.SnapshotPayload, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheEvents.SnapshotPayload)(payload).pipe(
    Effect.mapError((cause) => decodeFailed(`could not decode a ${CacheEvents.snapshotEventType} payload`, cause))
  )

const entryOf = (snapshot: CacheEvents.SnapshotPayload): CacheEntry => ({
  keyDigest: snapshot.keyDigest,
  result: snapshot.result,
  meta: snapshot.meta,
  createdAtMs: snapshot.createdAtMs,
  recordedRunId: snapshot.recordedRunId,
  recordedEventSeq: snapshot.recordedEventSeq
})

/**
 * One event applied to the head materialization. The reducer implements the
 * same admission the live SQL does: the first `recorded` event for a vacant
 * key inserts the head — first writer wins — later ones do not, and an
 * eviction deletes only the generation whose provenance it carries, so a
 * rebuild never resurrects a poisoned head and never drops a fresher row.
 */
const applyHead = (
  head: Map<string, CacheEntry>,
  eventType: string,
  payload: unknown
): Effect.Effect<void, CacheStoreError> => {
  switch (eventType) {
    case CacheEvents.recordedEventType:
      return Effect.map(decodeEntryPayload(payload), (entry) => {
        if (!head.has(entry.keyDigest)) {
          head.set(entry.keyDigest, entry)
        }
      })
    case CacheEvents.evictedEventType:
      return Effect.map(decodeEvictedPayload(payload), (evicted) => {
        const current = head.get(evicted.keyDigest)
        if (
          current !== undefined &&
          current.recordedRunId === evicted.recordedRunId &&
          current.recordedEventSeq === evicted.recordedEventSeq
        ) {
          head.delete(evicted.keyDigest)
        }
      })
    case CacheEvents.snapshotEventType:
      return Effect.map(decodeSnapshotPayload(payload), (snapshot) => {
        if (snapshot.table === "head" && !head.has(snapshot.keyDigest)) {
          head.set(snapshot.keyDigest, entryOf(snapshot))
        }
      })
    default:
      return Effect.void
  }
}

/**
 * One event applied to the ledger materialization. Inserts are
 * first-writer-wins per provenance triple, and nothing deletes a ledger
 * row — eviction is a head concern, and durable ledger reclamation is
 * journal compaction, which removes the events themselves.
 */
const applyLedger = (
  ledger: Map<string, CacheEntry>,
  eventType: string,
  payload: unknown
): Effect.Effect<void, CacheStoreError> => {
  switch (eventType) {
    case CacheEvents.recordedEventType:
      return Effect.map(decodeEntryPayload(payload), (entry) => {
        const key = tripleKey(entry.keyDigest, entry.recordedRunId, entry.recordedEventSeq)
        if (!ledger.has(key)) {
          ledger.set(key, entry)
        }
      })
    case CacheEvents.snapshotEventType:
      return Effect.map(decodeSnapshotPayload(payload), (snapshot) => {
        if (snapshot.table !== "recorded") {
          return
        }
        const key = tripleKey(snapshot.keyDigest, snapshot.recordedRunId, snapshot.recordedEventSeq)
        if (!ledger.has(key)) {
          ledger.set(key, entryOf(snapshot))
        }
      })
    default:
      return Effect.void
  }
}

/**
 * The head fold of one run's committed entries, as a reproducible journal
 * projection with no independent durable state.
 *
 * @category projections
 * @since 0.1.0
 */
export const head: Projection.Projection<HeadState, CacheStoreError> = Projection.make<HeadState, CacheStoreError>({
  name: "@smthrs/step-cache/Fold/head",
  initial: new Map<string, CacheEntry>(),
  reduce: (state, entry) =>
    Effect.suspend(() => {
      if (!entry.eventType.startsWith(namespace)) {
        return Effect.succeed(state)
      }
      const next = new Map(state)
      return applyHead(next, entry.eventType, entry.payload).pipe(Effect.as(next))
    })
})

/**
 * The ledger fold of one run's committed entries, as a reproducible journal
 * projection with no independent durable state.
 *
 * @category projections
 * @since 0.1.0
 */
export const ledger: Projection.Projection<LedgerState, CacheStoreError> = Projection.make<
  LedgerState,
  CacheStoreError
>({
  name: "@smthrs/step-cache/Fold/ledger",
  initial: new Map<string, CacheEntry>(),
  reduce: (state, entry) =>
    Effect.suspend(() => {
      if (!entry.eventType.startsWith(namespace)) {
        return Effect.succeed(state)
      }
      const next = new Map(state)
      return applyLedger(next, entry.eventType, entry.payload).pipe(Effect.as(next))
    })
})

/**
 * What a {@link rebuild} recomputed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Rebuilt {
  /** How many retained `flows.cache.*` entries the fold replayed. */
  readonly entries: number
  /** Head rows materialized. */
  readonly head: number
  /** Ledger rows materialized. */
  readonly ledger: number
}

interface EventRow {
  readonly run_id: string
  readonly seq: number
  readonly event_type: string
  readonly payload_json: string
}

const mapRebuildError = (cause: unknown): CacheStoreError =>
  Schema.is(CacheStoreError)(cause)
    ? cause
    : new CacheStoreError({ code: "persistence_failed", message: "cache rebuild failed", cause })

/**
 * Truncates and repopulates both tables from the retained journal inside one
 * `DurableWriter` transaction.
 *
 * Lookup keeps reading the tables; this operation is what makes their
 * demotion from contract to cache honest, and is what recovery, disaster
 * rebuild, and time travel's restore-to-frame recompute run. Rows are
 * materialized through the same canonical encoding the live write uses, so a
 * rebuilt row is byte-equal to the row it replaces.
 *
 * Replay order is commit order: within a run, `seq`; across runs,
 * `emitted_at_ms` — stamped inside the store's serialized write transaction,
 * so it is nondecreasing in commit order — with `(run_id, seq)` as the
 * deterministic tie-break inside one millisecond. The fold state is held in
 * memory and is proportional to the retained cache history.
 *
 * @category operations
 * @since 0.1.0
 */
export const rebuild: Effect.Effect<
  Rebuilt,
  CacheStoreError,
  DurableWriter | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  return yield* writer.write(Effect.gen(function*() {
    const rows = yield* sql<EventRow>`
      SELECT run_id, seq, event_type, payload_json
      FROM flows_journal_events
      WHERE event_type IN (
        ${CacheEvents.recordedEventType},
        ${CacheEvents.evictedEventType},
        ${CacheEvents.snapshotEventType}
      )
      ORDER BY emitted_at_ms ASC, run_id ASC, seq ASC
    `
    const headRows = new Map<string, CacheEntry>()
    const ledgerRows = new Map<string, CacheEntry>()
    for (const row of rows) {
      const payload = yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(row.payload_json).pipe(
        Effect.mapError((cause) =>
          decodeFailed(`could not decode the payload of ${row.event_type} at ${row.run_id}:${row.seq}`, cause)
        )
      )
      yield* applyHead(headRows, row.event_type, payload)
      yield* applyLedger(ledgerRows, row.event_type, payload)
    }
    yield* sql`DELETE FROM flows_step_cache`
    yield* sql`DELETE FROM flows_step_cache_recorded`
    for (
      const [table, entries] of [
        ["flows_step_cache", headRows],
        ["flows_step_cache_recorded", ledgerRows]
      ] as const
    ) {
      for (const entry of entries.values()) {
        const result = yield* encodeCanonical(entry.result, "result")
        const meta = yield* encodeCanonical(entry.meta, "meta")
        yield* sql`
          INSERT INTO ${sql(table)} (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES (
            ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
          )
        `
      }
    }
    return {
      entries: rows.length,
      head: headRows.size,
      ledger: ledgerRows.size
    } satisfies Rebuilt
  })).pipe(Effect.mapError(mapRebuildError))
})
