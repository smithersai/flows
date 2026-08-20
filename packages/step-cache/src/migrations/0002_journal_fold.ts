/**
 * Backfills the journal behind pre-fold cache rows.
 *
 * Rows written before the fold have no events behind them, so dropping the
 * tables would erase them from history. This migration appends one
 * `flows.cache.snapshot` per existing head row and per existing ledger row —
 * ordinary entries with valid per-run sequence numbers under each row's
 * recorded run — before the new contract takes effect, so a pre-fold database
 * survives migrate, drop, and rebuild with equivalent state. The stage 1,
 * round 2 lesson of `docs/specs/Concepts/Journal Consensus.md` (a migration
 * must not orphan live state) applied to cache rows.
 *
 * Requires `@smthrs/journal`'s migration set installed first: the snapshots
 * land in `flows_journal_events`.
 *
 * @since 0.1.0
 */
import { makeEventId, type RunId, type SourceId, type SourceSeq } from "@smthrs/journal/JournalEvent"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as CacheEvents from "../internal/CacheEvents.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

interface PreFoldRow {
  readonly key_digest: string
  readonly result_json: string
  readonly meta_json: string
  readonly created_at_ms: number
  readonly recorded_run_id: string
  readonly recorded_event_seq: number
}

const journalFold: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const emittedAtMs = yield* Clock.currentTimeMillis
  const heads = yield* sql<PreFoldRow>`
    SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
    FROM flows_step_cache
    ORDER BY key_digest
  `
  const ledger = yield* sql<PreFoldRow>`
    SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
    FROM flows_step_cache_recorded
    ORDER BY key_digest, recorded_run_id, recorded_event_seq
  `
  // The per-run sequence floor, read once per run this backfill touches and
  // advanced locally: the whole migrator pass is one transaction, so no
  // concurrent writer can take a number from under it.
  const floors = new Map<string, number>()
  for (const [table, rows] of [["head", heads], ["recorded", ledger]] as const) {
    for (const row of rows) {
      const runId = row.recorded_run_id
      let floor = floors.get(runId)
      if (floor === undefined) {
        const next = yield* sql<{ readonly next: number | null }>`
          SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${runId}
        `
        floor = Number(next[0]?.next ?? 0)
      }
      floors.set(runId, floor + 1)
      const sourceId = `${
        CacheEvents.sourceId(row.key_digest, runId, Number(row.recorded_event_seq))
      }:snapshot:${table}`
      const payload: CacheEvents.SnapshotPayload = {
        table,
        keyDigest: row.key_digest,
        result: yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(row.result_json),
        meta: yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(row.meta_json),
        createdAtMs: Number(row.created_at_ms),
        recordedRunId: runId,
        recordedEventSeq: Number(row.recorded_event_seq)
      }
      yield* sql`
        INSERT INTO flows_journal_events (
          run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
          event_type, payload_json, meta_json
        ) VALUES (
          ${runId},
          ${floor},
          ${makeEventId(runId as RunId, sourceId as SourceId, 0 as SourceSeq)},
          ${sourceId},
          0,
          ${emittedAtMs},
          ${CacheEvents.snapshotEventType},
          ${yield* Schema.encodeUnknownEffect(UnknownFromJsonString)(payload)},
          ${yield* Schema.encodeUnknownEffect(UnknownFromJsonString)({ lineageId: CacheEvents.lineageId(runId) })}
        )
      `
    }
  }
})

export default journalFold
