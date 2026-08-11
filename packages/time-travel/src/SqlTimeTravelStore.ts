import { DurableWriter } from "@smthrs/database/DurableWriter"
import { RunState } from "@smthrs/engine-store/RunState"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { LineageEdge } from "./Frame.ts"
import { error, TimeTravelError } from "./TimeTravelError.ts"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/** Creates the time-travel tables. The SQL uses only portable scalar columns. @since 0.1.0 @category migrations */
export const migrate: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    rate_limit_json TEXT CHECK (rate_limit_json IS NULL OR json_valid(rate_limit_json)),
    detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS flows_time_travel_audits_status_idx
    ON flows_time_travel_audits (status)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    audit_id TEXT NOT NULL CHECK (length(audit_id) > 0),
    effect_id TEXT NOT NULL CHECK (length(effect_id) > 0),
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_snapshots (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    change_id TEXT NOT NULL CHECK (length(change_id) > 0),
    PRIMARY KEY (run_id, lineage_id, seq)
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_edges (
    parent_run_id TEXT NOT NULL CHECK (length(parent_run_id) > 0),
    parent_seq INTEGER NOT NULL CHECK (
      typeof(parent_seq) = 'integer' AND parent_seq >= 0 AND parent_seq <= 9007199254740991
    ),
    child_run_id TEXT NOT NULL UNIQUE CHECK (length(child_run_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('child', 'fork', 'continuation')),
    attached INTEGER NOT NULL CHECK (attached IN (0, 1)),
    CHECK (parent_run_id <> child_run_id)
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS flows_time_travel_edges_parent_idx
    ON flows_time_travel_edges (parent_run_id, parent_seq)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    event_id TEXT NOT NULL CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq INTEGER NOT NULL CHECK (
      typeof(source_seq) = 'integer' AND source_seq >= 0 AND source_seq <= 9007199254740991
    ),
    emitted_at_ms INTEGER NOT NULL CHECK (
      typeof(emitted_at_ms) = 'integer' AND emitted_at_ms >= 0 AND emitted_at_ms <= 9007199254740991
    ),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    archived_at_ms INTEGER NOT NULL CHECK (
      typeof(archived_at_ms) = 'integer' AND archived_at_ms >= 0 AND archived_at_ms <= 9007199254740991
    ),
    PRIMARY KEY (run_id, seq)
  )`
})
const Json = Schema.UnknownFromJsonString
const RunStateJson = Schema.fromJsonString(RunState)
const mapError = (cause: unknown) =>
  cause instanceof TimeTravelError ? cause : error("unknown", "time-travel persistence failed", cause)
const decodeJson = (value: string | null) =>
  value === null
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Json)(value).pipe(Effect.mapError(mapError))
const encodeJson = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.mapError(mapError))

const restartableStateJson = (stateJson: string) =>
  Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(
    Effect.flatMap((state) => {
      const { cancellation: _, result: __, ...restartable } = state
      return Schema.encodeEffect(RunStateJson)(restartable)
    }),
    Effect.mapError((cause) => error("unknown", "could not materialize executable fork state", cause))
  )

/** @private */
const EdgeRow = Schema.Struct({
  parent_run_id: Schema.NonEmptyString,
  parent_seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  child_run_id: Schema.NonEmptyString,
  kind: Schema.Literals(["child", "fork", "continuation"]),
  attached: Schema.Literals([0, 1])
})

/** @private */
type EdgeRow = typeof EdgeRow.Type

const decodeEdges = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(EdgeRow))(rows).pipe(Effect.mapError(mapError))

const edgeFromRow = (row: EdgeRow): LineageEdge => ({
  parentRunId: row.parent_run_id,
  parentSeq: row.parent_seq,
  childRunId: row.child_run_id,
  kind: row.kind,
  attached: row.attached === 1
})

const descendantsFrom = (
  rows: ReadonlyArray<EdgeRow>,
  runId: string,
  frame: TimeTravelStore.Snapshot["frame"]
): {
  readonly attached: ReadonlyArray<LineageEdge>
  readonly detached: ReadonlyArray<LineageEdge>
  readonly attachedRunIds: ReadonlySet<string>
} => {
  const edges = rows.map(edgeFromRow)
  const attached: Array<LineageEdge> = []
  const detached: Array<LineageEdge> = []
  const attachedRunIds = new Set<string>()
  const queue: Array<string> = []
  const include = (edge: LineageEdge): void => {
    if (edge.attached) {
      if (attachedRunIds.has(edge.childRunId)) return
      attached.push(edge)
      attachedRunIds.add(edge.childRunId)
      queue.push(edge.childRunId)
    } else {
      detached.push(edge)
    }
  }
  for (const edge of edges) {
    if (edge.parentRunId === runId && edge.parentSeq > frame.seq) include(edge)
  }
  while (queue.length > 0) {
    const parentRunId = queue.shift()!
    for (const edge of edges) {
      if (edge.parentRunId === parentRunId) include(edge)
    }
  }
  return { attached, detached, attachedRunIds }
}

/** @since 0.1.0 @category constructors */
export const make: Effect.Effect<TimeTravelStore.Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(
  function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter

    yield* migrate.pipe(Effect.mapError(() => undefined), Effect.orDie)
    return TimeTravelStore.make({
      snapshotAt: Effect.fn("TimeTravelStore.snapshotAt")((runId, frame) =>
        sql<
          { readonly change_id: string; readonly seq: number }
        >`SELECT change_id, seq FROM flows_time_travel_snapshots WHERE run_id = ${runId} AND lineage_id = ${frame.lineageId} AND seq <= ${frame.seq} ORDER BY seq DESC LIMIT 1`
          .pipe(
            Effect.map((rows) =>
              rows[0] === undefined
                ? undefined
                : { runId, frame: { lineageId: frame.lineageId, seq: rows[0].seq }, changeId: rows[0].change_id }
            ),
            Effect.mapError(mapError)
          )
      ),
      descendants: Effect.fn("TimeTravelStore.descendants")((runId, frame) =>
        sql<EdgeRow>`SELECT parent_run_id, parent_seq, child_run_id, kind, attached FROM flows_time_travel_edges`.pipe(
          Effect.flatMap(decodeEdges),
          Effect.map((rows) => {
            const descendants = descendantsFrom(rows, runId, frame)
            return { attached: descendants.attached, detached: descendants.detached }
          }),
          Effect.mapError(mapError)
        )
      ),
      writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
        writer.write(
          Effect.gen(function*() {
            const rateLimit = audit.rateLimit === undefined ? null : yield* encodeJson(audit.rateLimit)
            const detail = audit.detail === undefined ? null : yield* encodeJson(audit.detail)
            yield* sql`INSERT INTO flows_time_travel_audits (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json) VALUES (${audit.id}, ${audit.runId}, ${audit.frame.lineageId}, ${audit.frame.seq}, ${audit.status}, ${rateLimit}, ${detail})`
          })
        ).pipe(Effect.asVoid, Effect.mapError(mapError))
      ),
      updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
        writer.write(
          Effect.gen(function*() {
            const rows = yield* sql<
              {
                readonly id: string
                readonly run_id: string
                readonly lineage_id: string
                readonly seq: number
                readonly status: TimeTravelStore.Audit["status"]
                readonly rate_limit_json: string | null
                readonly detail_json: string | null
              }
            >`SELECT * FROM flows_time_travel_audits WHERE id = ${id}`
            if (rows[0] === undefined) return yield* Effect.fail(error("not_found", `audit ${id} was not found`))
            const row = rows[0]
            const rateLimit = yield* decodeJson(row.rate_limit_json)
            const detail = yield* decodeJson(row.detail_json)
            const audit = {
              id: row.id,
              runId: row.run_id,
              frame: { lineageId: row.lineage_id, seq: row.seq },
              status: row.status,
              rateLimit,
              detail
            }
            const next = { ...audit, ...patch }
            const rateLimitJson = next.rateLimit === undefined ? null : yield* encodeJson(next.rateLimit)
            const detailJson = next.detail === undefined ? null : yield* encodeJson(next.detail)
            yield* sql`UPDATE flows_time_travel_audits SET status = ${next.status}, rate_limit_json = ${rateLimitJson}, detail_json = ${detailJson} WHERE id = ${id}`
          }).pipe(Effect.mapError(mapError))
        ).pipe(Effect.mapError(mapError), Effect.asVoid)
      ),
      pendingAudits: Effect.fn("TimeTravelStore.pendingAudits")(() =>
        sql<
          {
            readonly id: string
            readonly run_id: string
            readonly lineage_id: string
            readonly seq: number
            readonly status: "in_progress"
            readonly rate_limit_json: string | null
            readonly detail_json: string | null
          }
        >`SELECT * FROM flows_time_travel_audits WHERE status = 'in_progress'`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.gen(function*() {
                const rateLimit = yield* decodeJson(row.rate_limit_json)
                const detail = yield* decodeJson(row.detail_json)
                return {
                  id: row.id,
                  runId: row.run_id,
                  frame: { lineageId: row.lineage_id, seq: row.seq },
                  status: row.status,
                  rateLimit,
                  detail
                }
              }))
          ),
          Effect.mapError(mapError)
        )
      ),
      archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")((runId, frame, receipts) =>
        writer.write(
          Effect.gen(function*() {
            const rows = yield* sql<EdgeRow>`
            SELECT parent_run_id, parent_seq, child_run_id, kind, attached
            FROM flows_time_travel_edges
          `.pipe(Effect.flatMap(decodeEdges))
            const descendants = descendantsFrom(rows, runId, frame)
            const nowMs = yield* Clock.currentTimeMillis
            const parentCount = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
            let archived = Number(parentCount[0]!.count)
            yield* sql`
            INSERT OR IGNORE INTO flows_time_travel_archive
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                   event_type, payload_json, meta_json, ${nowMs}
            FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
            yield* sql`
            DELETE FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
            for (const childRunId of descendants.attachedRunIds) {
              const count = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_journal_events
              WHERE run_id = ${childRunId}
            `
              archived += Number(count[0]!.count)
              yield* sql`
              INSERT OR IGNORE INTO flows_time_travel_archive
              SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                     event_type, payload_json, meta_json, ${nowMs}
              FROM flows_journal_events WHERE run_id = ${childRunId}
            `
              yield* sql`DELETE FROM flows_journal_events WHERE run_id = ${childRunId}`
            }
            for (const edge of descendants.attached) {
              yield* sql`DELETE FROM flows_time_travel_edges WHERE child_run_id = ${edge.childRunId}`
            }
            for (const receipt of receipts) {
              const receiptJson = yield* encodeJson(receipt.receipt)
              yield* sql`
              INSERT INTO flows_time_travel_receipts
                (id, audit_id, effect_id, receipt_json)
              VALUES (
                ${receipt.id},
                ${receipt.auditId},
                ${receipt.effectId},
                ${receiptJson}
              )
            `
            }
            return { archived, orphaned: descendants.detached }
          }).pipe(Effect.mapError(mapError))
        ).pipe(Effect.mapError(mapError))
      ),
      createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame) =>
        writer.write(
          Effect.gen(function*() {
            let currentRunId: string | undefined = parentRunId
            const seen = new Set<string>()
            while (currentRunId !== undefined && !seen.has(currentRunId)) {
              seen.add(currentRunId)
              const current = yield* sql<{
                readonly status: string
                readonly owner_host_id: string | null
                readonly claim_host_id: string | null
              }>`
              SELECT status, owner_host_id, claim_host_id
              FROM flows_runs WHERE run_id = ${currentRunId}
            `
              if (current[0] === undefined) {
                return yield* Effect.fail(error("not_found", `parent ${currentRunId} was not found`))
              }
              if (
                current[0].status === "running" ||
                current[0].owner_host_id !== null ||
                current[0].claim_host_id !== null
              ) {
                return yield* Effect.fail(error("live_parent", `parent ${currentRunId} is live`))
              }
              const parentEdges: ReadonlyArray<{ readonly parent_run_id: string }> = yield* sql<{
                readonly parent_run_id: string
              }>`
              SELECT parent_run_id FROM flows_time_travel_edges
              WHERE child_run_id = ${currentRunId}
            `
              currentRunId = parentEdges[0]?.parent_run_id
            }
            const existing = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_time_travel_edges
            WHERE parent_run_id = ${parentRunId} AND parent_seq = ${frame.seq}
          `
            const runId = `${parentRunId}:fork:${frame.seq}:${Number(existing[0]!.count) + 1}`
            const nowMs = yield* Clock.currentTimeMillis
            const parentState = yield* sql<{ readonly state_json: string }>`
            SELECT state_json FROM flows_runs WHERE run_id = ${parentRunId}
          `
            const stateJson = yield* restartableStateJson(parentState[0]!.state_json)
            yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json)
            VALUES (${runId}, 'pending', ${nowMs}, ${parentRunId}, ${stateJson})
          `
            yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            SELECT ${runId}, seq, ${`fork:${runId}:`} || event_id,
                   source_id, source_seq, emitted_at_ms,
                   event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE run_id = ${parentRunId} AND seq <= ${frame.seq}
          `
            yield* sql`
            INSERT INTO flows_attempts (
              run_id,
              step_key_digest,
              attempt,
              state,
              started_at_ms,
              finished_at_ms,
              heartbeat_at_ms,
              checkpoint_json,
              error_json,
              outcome_json,
              meta_json
            )
            SELECT
              ${runId},
              step_key_digest,
              attempt,
              state,
              started_at_ms,
              finished_at_ms,
              heartbeat_at_ms,
              checkpoint_json,
              error_json,
              outcome_json,
              meta_json
            FROM flows_attempts
            WHERE run_id = ${parentRunId}
          `
            yield* sql`
            INSERT INTO flows_time_travel_edges
              (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, ${frame.seq}, ${runId}, 'fork', 0)
          `
            return {
              runId,
              edge: {
                parentRunId,
                parentSeq: frame.seq,
                childRunId: runId,
                kind: "fork" as const,
                attached: false
              }
            }
          }).pipe(Effect.mapError(mapError))
        ).pipe(Effect.mapError(mapError))
      ),
      recordReceipt: Effect.fn("TimeTravelStore.recordReceipt")((receipt) =>
        writer.write(
          Effect.gen(function*() {
            const receiptJson = yield* encodeJson(receipt.receipt)
            yield* sql`INSERT INTO flows_time_travel_receipts (id, audit_id, effect_id, receipt_json) VALUES (${receipt.id}, ${receipt.auditId}, ${receipt.effectId}, ${receiptJson})`
          })
        ).pipe(Effect.asVoid, Effect.mapError(mapError))
      )
    })
  }
)
/** @since 0.1.0 @category layers */
export const layer: Layer.Layer<TimeTravelStore.TimeTravelStore, never, DurableWriter | SqlClient.SqlClient> = Layer
  .effect(
    TimeTravelStore.TimeTravelStore
  )(make)
