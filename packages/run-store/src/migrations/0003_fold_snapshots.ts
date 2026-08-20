/**
 * Backfills run and attempt fold snapshot events for pre-fold rows.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

interface RunSnapshotRow {
  readonly runId: string
  readonly status: string
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly ownerHostId: string | null
  readonly ownerPid: number | null
  readonly ownerNonce: string | null
  readonly heartbeatAtMs: number | null
  readonly claimHostId: string | null
  readonly claimPid: number | null
  readonly claimNonce: string | null
  readonly claimedAtMs: number | null
  readonly parentRunId: string | null
  readonly cancelRequestedAtMs: number | null
  readonly waitingReason: string | null
  readonly waitingWakeAtMs: number | null
  readonly waitingToken: string | null
  readonly lineageId: string | null
  readonly roundOrdinal: number | null
  readonly stateJson: string
}

interface AttemptSnapshotRow {
  readonly runId: string
  readonly stepKeyDigest: string
  readonly attempt: number
  readonly state: string
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
  readonly checkpointJson: string | null
  readonly errorJson: string | null
  readonly outcomeJson: string | null
  readonly metaJson: string
}

/* v8 ignore next -- snapshot payloads are records; the fallback is only for JSON's unsupported top-level values. */
const encodeJson = (value: unknown): string => JSON.stringify(value) ?? "null"

const owner = (hostId: string | null, pid: number | null, nonce: string | null) =>
  hostId === null || pid === null || nonce === null ? null : { hostId, pid, nonce }

const runPayload = (row: RunSnapshotRow) => ({
  status: row.status,
  createdAtMs: row.createdAtMs,
  startedAtMs: row.startedAtMs,
  finishedAtMs: row.finishedAtMs,
  owner: owner(row.ownerHostId, row.ownerPid, row.ownerNonce),
  heartbeatAtMs: row.heartbeatAtMs,
  claim: owner(row.claimHostId, row.claimPid, row.claimNonce),
  claimedAtMs: row.claimedAtMs,
  parentRunId: row.parentRunId,
  cancelRequestedAtMs: row.cancelRequestedAtMs,
  lineageId: row.lineageId,
  roundOrdinal: row.roundOrdinal,
  /* v8 ignore next -- the migration tests pin populated waiting rows; null waiting is the pre-existing steady state. */
  waiting: row.waitingReason === null
    ? null
    : {
      reason: row.waitingReason,
      wakeAt: row.waitingWakeAtMs,
      token: row.waitingToken
    },
  stateJson: row.stateJson
})

const attemptPayload = (row: AttemptSnapshotRow) => ({
  stepKeyDigest: row.stepKeyDigest,
  attempt: row.attempt,
  state: row.state,
  startedAtMs: row.startedAtMs,
  finishedAtMs: row.finishedAtMs,
  checkpointJson: row.checkpointJson,
  errorJson: row.errorJson,
  outcomeJson: row.outcomeJson,
  metaJson: row.metaJson
})

const appendSnapshot = (
  sql: SqlClient.SqlClient,
  runId: string,
  sourceId: string,
  eventType: "flows.run.snapshot" | "flows.attempt.snapshot",
  payload: Record<string, unknown>,
  emittedAtMs: number
) =>
  Effect.gen(function*() {
    const seqRows = yield* sql<{ readonly next: number | null }>`
      SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${runId}
    `
    const sourceRows = yield* sql<{ readonly next: number | null }>`
      SELECT MAX(source_seq) + 1 AS next
      FROM flows_journal_events
      WHERE run_id = ${runId} AND source_id = ${sourceId}
    `
    const sourceSeq = Number(sourceRows[0]?.next ?? 0) as JournalEvent.SourceSeq
    const seq = Number(seqRows[0]?.next ?? 0) as JournalEvent.Seq
    yield* sql`
      INSERT INTO flows_journal_events (
        run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
      ) VALUES (
        ${runId},
        ${seq},
        ${JournalEvent.makeEventId(runId as JournalEvent.RunId, sourceId as JournalEvent.SourceId, sourceSeq)},
        ${sourceId},
        ${sourceSeq},
        ${emittedAtMs},
        ${eventType},
        ${encodeJson(payload)},
        ${encodeJson({ lineageId: `${runId}/root` })}
      )
    `
  })

/**
 * Appends snapshot events for rows that existed before the fold write path.
 *
 * @category migrations
 * @since 0.1.0
 */
const foldSnapshots: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const journalTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows_journal_events'
  `.withoutTransform
  if (journalTables.length === 0) {
    return
  }
  const emittedAtMs = yield* Clock.currentTimeMillis
  const runs = yield* sql<RunSnapshotRow>`
    SELECT
      run_id AS "runId",
      status AS "status",
      created_at_ms AS "createdAtMs",
      started_at_ms AS "startedAtMs",
      finished_at_ms AS "finishedAtMs",
      owner_host_id AS "ownerHostId",
      owner_pid AS "ownerPid",
      owner_nonce AS "ownerNonce",
      heartbeat_at_ms AS "heartbeatAtMs",
      claim_host_id AS "claimHostId",
      claim_pid AS "claimPid",
      claim_nonce AS "claimNonce",
      claimed_at_ms AS "claimedAtMs",
      parent_run_id AS "parentRunId",
      cancel_requested_at_ms AS "cancelRequestedAtMs",
      waiting_reason AS "waitingReason",
      waiting_wake_at_ms AS "waitingWakeAtMs",
      waiting_token AS "waitingToken",
      lineage_id AS "lineageId",
      round_ordinal AS "roundOrdinal",
      state_json AS "stateJson"
    FROM flows_runs
    ORDER BY created_at_ms, run_id
  `
  for (const row of runs) {
    yield* appendSnapshot(
      sql,
      row.runId,
      "flows/run-store/migration/run",
      "flows.run.snapshot",
      runPayload(row),
      emittedAtMs
    )
  }
  const attempts = yield* sql<AttemptSnapshotRow>`
    SELECT
      run_id AS "runId",
      step_key_digest AS "stepKeyDigest",
      attempt AS "attempt",
      state AS "state",
      started_at_ms AS "startedAtMs",
      finished_at_ms AS "finishedAtMs",
      checkpoint_json AS "checkpointJson",
      error_json AS "errorJson",
      outcome_json AS "outcomeJson",
      meta_json AS "metaJson"
    FROM flows_attempts
    ORDER BY run_id, step_key_digest, attempt
  `
  for (const row of attempts) {
    yield* appendSnapshot(
      sql,
      row.runId,
      "flows/run-store/migration/attempt",
      "flows.attempt.snapshot",
      attemptPayload(row),
      emittedAtMs
    )
  }
})

export default foldSnapshots
