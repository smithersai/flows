import { Database } from "@flows/database/Database"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { LineageEdge } from "./Frame.ts"
import { error } from "./TimeTravelError.ts"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/** Creates the time-travel tables. The SQL uses only portable scalar columns. @since 0.1.0 @category migrations */
export const migrate: Effect.Effect<void, unknown, Database> = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, lineage_id TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, rate_limit_json TEXT, detail_json TEXT)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL, effect_id TEXT NOT NULL, receipt_json TEXT NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_snapshots (run_id TEXT NOT NULL, lineage_id TEXT NOT NULL, seq INTEGER NOT NULL, change_id TEXT NOT NULL, PRIMARY KEY (run_id, lineage_id, seq))`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_edges (parent_run_id TEXT NOT NULL, parent_seq INTEGER NOT NULL, child_run_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, attached INTEGER NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, source_id TEXT NOT NULL, source_seq INTEGER NOT NULL, emitted_at_ms INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, meta_json TEXT NOT NULL, archived_at_ms INTEGER NOT NULL, PRIMARY KEY (run_id, seq))`
})
const decode = (value: string | null): unknown | undefined => value === null ? undefined : JSON.parse(value) as unknown
const mapError = (cause: unknown) => error("unknown", "time-travel persistence failed", cause)

interface EdgeRow {
  readonly parent_run_id: string
  readonly parent_seq: number
  readonly child_run_id: string
  readonly kind: LineageEdge["kind"]
  readonly attached: number
}

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
export const make: Effect.Effect<TimeTravelStore.Service, never, Database> = Effect.gen(function*() {
  const database = yield* Database
  const { sql } = database
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
        Effect.map((rows) => {
          const descendants = descendantsFrom(rows, runId, frame)
          return { attached: descendants.attached, detached: descendants.detached }
        }),
        Effect.mapError(mapError)
      )
    ),
    writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
      database.write(
        sql`INSERT INTO flows_time_travel_audits (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json) VALUES (${audit.id}, ${audit.runId}, ${audit.frame.lineageId}, ${audit.frame.seq}, ${audit.status}, ${
          audit.rateLimit === undefined ? null : JSON.stringify(audit.rateLimit)
        }, ${audit.detail === undefined ? null : JSON.stringify(audit.detail)})`
      ).pipe(Effect.asVoid, Effect.mapError(mapError))
    ),
    updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
      database.write(
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
          const audit = {
            id: row.id,
            runId: row.run_id,
            frame: { lineageId: row.lineage_id, seq: row.seq },
            status: row.status,
            rateLimit: decode(row.rate_limit_json),
            detail: decode(row.detail_json)
          }
          const next = { ...audit, ...patch }
          yield* sql`UPDATE flows_time_travel_audits SET status = ${next.status}, rate_limit_json = ${
            next.rateLimit === undefined ? null : JSON.stringify(next.rateLimit)
          }, detail_json = ${next.detail === undefined ? null : JSON.stringify(next.detail)} WHERE id = ${id}`
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
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            runId: row.run_id,
            frame: { lineageId: row.lineage_id, seq: row.seq },
            status: row.status,
            rateLimit: decode(row.rate_limit_json),
            detail: decode(row.detail_json)
          }))
        ),
        Effect.mapError(mapError)
      )
    ),
    archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")((runId, frame, receipts) =>
      database.write(
        Effect.gen(function*() {
          const rows = yield* sql<EdgeRow>`
            SELECT parent_run_id, parent_seq, child_run_id, kind, attached
            FROM flows_time_travel_edges
          `
          const descendants = descendantsFrom(rows, runId, frame)
          const nowMs = yield* Clock.currentTimeMillis
          const parentCount = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
          let archived = Number(parentCount[0]?.count ?? 0)
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
            archived += Number(count[0]?.count ?? 0)
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
            yield* sql`
              INSERT INTO flows_time_travel_receipts
                (id, audit_id, effect_id, receipt_json)
              VALUES (
                ${receipt.id},
                ${receipt.auditId},
                ${receipt.effectId},
                ${JSON.stringify(receipt.receipt)}
              )
            `
          }
          return { archived, orphaned: descendants.detached }
        }).pipe(Effect.mapError(mapError))
      ).pipe(Effect.mapError(mapError))
    ),
    createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame) =>
      database.write(
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
          const runId = `${parentRunId}:fork:${frame.seq}:${Number(existing[0]?.count ?? 0) + 1}`
          const nowMs = yield* Clock.currentTimeMillis
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${runId}, 'pending', ${nowMs}, '{}')
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
      database.write(
        sql`INSERT INTO flows_time_travel_receipts (id, audit_id, effect_id, receipt_json) VALUES (${receipt.id}, ${receipt.auditId}, ${receipt.effectId}, ${
          JSON.stringify(receipt.receipt)
        })`
      ).pipe(Effect.asVoid, Effect.mapError(mapError))
    )
  })
})
/** @since 0.1.0 @category layers */
export const layer: Layer.Layer<TimeTravelStore.TimeTravelStore, never, Database> = Layer.effect(
  TimeTravelStore.TimeTravelStore
)(make)
