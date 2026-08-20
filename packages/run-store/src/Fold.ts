/**
 * Rebuildable run and attempt materializations from journal entries.
 *
 * Governing design: `docs/specs/Concepts/Run State Fold.md`.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { RunStatus } from "./RunStore.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * Folded `flows_runs` row state.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunFoldRow {
  readonly runId: string
  readonly status: RunStatus
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly owner: OwnerId | null
  readonly heartbeatAtMs: number | null
  readonly claim: OwnerId | null
  readonly claimedAtMs: number | null
  readonly parentRunId: string | null
  readonly cancelRequestedAtMs: number | null
  readonly lineageId: string | null
  readonly roundOrdinal: number | null
  readonly waitingReason: string | null
  readonly waitingWakeAtMs: number | null
  readonly waitingToken: string | null
  readonly stateJson: string
}

/**
 * Folded `flows_attempts` row state.
 *
 * @category models
 * @since 0.1.0
 */
export interface AttemptFoldRow {
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

/**
 * The in-memory result of replaying the run and attempt journal namespaces.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly runs: Map<string, RunFoldRow>
  readonly attempts: Map<string, AttemptFoldRow>
}

interface JournalRow {
  readonly run_id: string
  readonly seq: number
  readonly event_id: string
  readonly source_id: string
  readonly source_seq: number
  readonly emitted_at_ms: number
  readonly event_type: string
  readonly payload_json: string
  readonly meta_json: string
}

const terminalStatuses: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

const emptyState = (): State => ({ runs: new Map(), attempts: new Map() })

/**
 * Creates an empty run/attempt fold state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const initial = emptyState

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const own = (record: Record<string, unknown>, key: string): boolean => Object.hasOwn(record, key)

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null

const ownerFrom = (value: unknown): OwnerId | null => {
  const record = asRecord(value)
  if (record === undefined) return null
  return typeof record.hostId === "string" &&
      typeof record.pid === "number" &&
      Number.isSafeInteger(record.pid) &&
      typeof record.nonce === "string"
    ? { hostId: record.hostId, pid: record.pid, nonce: record.nonce }
    : null
}

const sameOwner = (left: OwnerId | null, right: OwnerId): boolean =>
  left !== null && left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

const encodeJson = (value: unknown): string | undefined => {
  const encoded = Schema.encodeUnknownResult(UnknownFromJsonString)(value)
  return Result.isSuccess(encoded) ? encoded.success : undefined
}

const jsonColumn = (
  payload: Record<string, unknown>,
  valueKey: string,
  jsonKey: string
): string | null | undefined => {
  const exact = payload[jsonKey]
  if (typeof exact === "string") return exact
  if (!own(payload, valueKey)) return undefined
  return encodeJson(payload[valueKey]) ?? null
}

const attemptKey = (runId: string, stepKeyDigest: string, attempt: number): string =>
  `${runId.length}:${runId}${stepKeyDigest.length}:${stepKeyDigest}${attempt}`

const setWaiting = (row: RunFoldRow, waiting: unknown): RunFoldRow => {
  if (waiting === null) {
    return { ...row, waitingReason: null, waitingWakeAtMs: null, waitingToken: null }
  }
  const record = asRecord(waiting)
  if (record === undefined || typeof record.reason !== "string") {
    return row
  }
  return {
    ...row,
    waitingReason: record.reason,
    waitingWakeAtMs: numberOrNull(record.wakeAt),
    waitingToken: stringOrNull(record.token)
  }
}

const applyRunEvent = (state: State, entry: JournalEvent.Entry, payload: Record<string, unknown>): void => {
  const runId = entry.runId
  if (entry.eventType === "flows.run.created") {
    const createdAtMs = numberOrNull(payload.createdAtMs)
    const stateJson = typeof payload.stateJson === "string" ? payload.stateJson : undefined
    if (createdAtMs === null || stateJson === undefined) return
    state.runs.set(runId, {
      runId,
      status: "pending",
      createdAtMs,
      startedAtMs: null,
      finishedAtMs: null,
      owner: null,
      heartbeatAtMs: null,
      claim: null,
      claimedAtMs: null,
      parentRunId: stringOrNull(payload.parentRunId),
      cancelRequestedAtMs: null,
      lineageId: stringOrNull(payload.lineageId),
      roundOrdinal: numberOrNull(payload.roundOrdinal),
      waitingReason: null,
      waitingWakeAtMs: null,
      waitingToken: null,
      stateJson
    })
    return
  }

  if (entry.eventType === "flows.run.snapshot") {
    const status = typeof payload.status === "string" ? payload.status as RunStatus : undefined
    const createdAtMs = numberOrNull(payload.createdAtMs)
    const stateJson = typeof payload.stateJson === "string" ? payload.stateJson : undefined
    if (status === undefined || createdAtMs === null || stateJson === undefined) return
    const waiting = own(payload, "waiting") ? asRecord(payload.waiting) : undefined
    state.runs.set(runId, {
      runId,
      status,
      createdAtMs,
      startedAtMs: numberOrNull(payload.startedAtMs),
      finishedAtMs: numberOrNull(payload.finishedAtMs),
      owner: ownerFrom(payload.owner),
      heartbeatAtMs: numberOrNull(payload.heartbeatAtMs),
      claim: ownerFrom(payload.claim),
      claimedAtMs: numberOrNull(payload.claimedAtMs),
      parentRunId: stringOrNull(payload.parentRunId),
      cancelRequestedAtMs: numberOrNull(payload.cancelRequestedAtMs),
      lineageId: stringOrNull(payload.lineageId),
      roundOrdinal: numberOrNull(payload.roundOrdinal),
      waitingReason: waiting === undefined ? null : stringOrNull(waiting.reason),
      waitingWakeAtMs: waiting === undefined ? null : numberOrNull(waiting.wakeAt),
      waitingToken: waiting === undefined ? null : stringOrNull(waiting.token),
      stateJson
    })
    return
  }

  const row = state.runs.get(runId)
  if (row === undefined) return

  if (entry.eventType === "flows.run.cancel-requested") {
    const requestedAtMs = numberOrNull(payload.requestedAtMs)
    if (requestedAtMs !== null) {
      state.runs.set(runId, { ...row, cancelRequestedAtMs: requestedAtMs })
    }
    return
  }

  if (entry.eventType !== "flows.run.transitioned") return
  const status = typeof payload.status === "string" ? payload.status as RunStatus : undefined
  const atMs = numberOrNull(payload.atMs)
  if (status === undefined || atMs === null) return
  const stateJson = typeof payload.stateJson === "string" ? payload.stateJson : row.stateJson
  const transitioned = status === "running"
    ? {
      ...row,
      status,
      startedAtMs: row.startedAtMs ?? atMs,
      finishedAtMs: null,
      stateJson
    }
    : {
      ...row,
      status,
      finishedAtMs: terminalStatuses.has(status) ? atMs : null,
      owner: null,
      heartbeatAtMs: null,
      claim: null,
      claimedAtMs: null,
      stateJson
    }
  state.runs.set(runId, own(payload, "waiting") ? setWaiting(transitioned, payload.waiting) : transitioned)
}

const applyConsensusEvent = (state: State, entry: JournalEvent.Entry, payload: Record<string, unknown>): void => {
  const row = state.runs.get(entry.runId)
  const owner = ownerFrom(payload.owner)
  if (row === undefined || owner === null) return
  const grantedAtMs = numberOrNull(payload.grantedAtMs)
  switch (entry.eventType) {
    case "flows.consensus.claimed":
    case "flows.consensus.stolen": {
      state.runs.set(entry.runId, { ...row, claim: owner, claimedAtMs: grantedAtMs })
      return
    }
    case "flows.consensus.activated": {
      state.runs.set(entry.runId, {
        ...row,
        owner,
        heartbeatAtMs: grantedAtMs,
        claim: null,
        claimedAtMs: null
      })
      return
    }
    case "flows.consensus.released": {
      state.runs.set(entry.runId, {
        ...row,
        owner: sameOwner(row.owner, owner) ? null : row.owner,
        heartbeatAtMs: sameOwner(row.owner, owner) ? null : row.heartbeatAtMs,
        claim: sameOwner(row.claim, owner) ? null : row.claim,
        claimedAtMs: sameOwner(row.claim, owner) ? null : row.claimedAtMs
      })
      return
    }
    case "flows.consensus.expired": {
      state.runs.set(entry.runId, {
        ...row,
        claim: sameOwner(row.claim, owner) ? null : row.claim,
        claimedAtMs: sameOwner(row.claim, owner) ? null : row.claimedAtMs
      })
      return
    }
  }
}

const applyAttemptEvent = (state: State, entry: JournalEvent.Entry, payload: Record<string, unknown>): void => {
  const stepKeyDigest = typeof payload.stepKeyDigest === "string" ? payload.stepKeyDigest : undefined
  const attempt = numberOrNull(payload.attempt)
  if (stepKeyDigest === undefined || attempt === null) return
  const key = attemptKey(entry.runId, stepKeyDigest, attempt)
  if (entry.eventType === "flows.attempt.put" || entry.eventType === "flows.attempt.snapshot") {
    const rowState = typeof payload.state === "string" ? payload.state : undefined
    const startedAtMs = numberOrNull(payload.startedAtMs)
    const metaJson = jsonColumn(payload, "meta", "metaJson")
    if (rowState === undefined || startedAtMs === null || metaJson === undefined || metaJson === null) return
    state.attempts.set(key, {
      runId: entry.runId,
      stepKeyDigest,
      attempt,
      state: rowState,
      startedAtMs,
      finishedAtMs: numberOrNull(payload.finishedAtMs),
      checkpointJson: jsonColumn(payload, "checkpoint", "checkpointJson") ?? null,
      errorJson: jsonColumn(payload, "error", "errorJson") ?? null,
      outcomeJson: jsonColumn(payload, "outcome", "outcomeJson") ?? null,
      metaJson
    })
    return
  }

  const row = state.attempts.get(key)
  if (row === undefined) return
  if (entry.eventType === "flows.attempt.checkpointed") {
    const checkpointJson = jsonColumn(payload, "checkpoint", "checkpointJson")
    if (checkpointJson !== undefined) {
      state.attempts.set(key, { ...row, checkpointJson })
    }
    return
  }
  if (entry.eventType === "flows.attempt.finished") {
    const rowState = typeof payload.state === "string" ? payload.state : undefined
    const finishedAtMs = numberOrNull(payload.finishedAtMs)
    if (rowState === undefined || finishedAtMs === null) return
    state.attempts.set(key, {
      ...row,
      state: rowState,
      finishedAtMs,
      errorJson: own(payload, "error") ? jsonColumn(payload, "error", "errorJson") ?? null : row.errorJson,
      outcomeJson: own(payload, "outcome") ? jsonColumn(payload, "outcome", "outcomeJson") ?? null : row.outcomeJson,
      metaJson: own(payload, "meta") ? jsonColumn(payload, "meta", "metaJson") ?? row.metaJson : row.metaJson
    })
    return
  }
  if (entry.eventType === "flows.attempt.patched") {
    state.attempts.set(key, {
      ...row,
      checkpointJson: own(payload, "checkpoint")
        ? jsonColumn(payload, "checkpoint", "checkpointJson") ?? null
        : row.checkpointJson,
      errorJson: own(payload, "error") ? jsonColumn(payload, "error", "errorJson") ?? null : row.errorJson,
      outcomeJson: own(payload, "outcome") ? jsonColumn(payload, "outcome", "outcomeJson") ?? null : row.outcomeJson,
      metaJson: own(payload, "meta") ? jsonColumn(payload, "meta", "metaJson") ?? row.metaJson : row.metaJson
    })
  }
}

const reduceSync = (state: State, entry: JournalEvent.Entry): State => {
  const payload = asRecord(entry.payload)
  if (payload === undefined) return state
  if (entry.eventType.startsWith("flows.run.")) {
    applyRunEvent(state, entry, payload)
  } else if (entry.eventType.startsWith("flows.consensus.")) {
    applyConsensusEvent(state, entry, payload)
  } else if (entry.eventType.startsWith("flows.attempt.")) {
    applyAttemptEvent(state, entry, payload)
  }
  return state
}

/**
 * Reduces one committed journal entry into a fold state.
 *
 * @category reducers
 * @since 0.1.0
 */
export const reduce = (state: State, entry: JournalEvent.Entry): Effect.Effect<State> =>
  Effect.sync(() => reduceSync(state, entry))

/**
 * Replays committed entries into a fresh fold state.
 *
 * @category reducers
 * @since 0.1.0
 */
export const foldEntries = (entries: Iterable<JournalEvent.Entry>): Effect.Effect<State> =>
  Effect.sync(() => {
    const state = initial()
    for (const entry of entries) {
      reduceSync(state, entry)
    }
    return state
  })

const decodeJson = (json: string): Effect.Effect<unknown> =>
  Effect.fromResult(Schema.decodeUnknownResult(UnknownFromJsonString)(json)).pipe(Effect.orDie)

const decodeEntry = (row: JournalRow): Effect.Effect<JournalEvent.Entry> =>
  Effect.all({
    payload: decodeJson(row.payload_json),
    meta: decodeJson(row.meta_json)
  }).pipe(
    Effect.map(({ payload, meta }) =>
      new JournalEvent.Entry({
        runId: row.run_id as JournalEvent.RunId,
        seq: row.seq as JournalEvent.Seq,
        eventId: row.event_id,
        sourceId: row.source_id as JournalEvent.SourceId,
        sourceSeq: row.source_seq as JournalEvent.SourceSeq,
        emittedAtMs: row.emitted_at_ms,
        eventType: row.event_type,
        payload,
        meta
      })
    )
  )

/**
 * Rebuilds `flows_runs` and `flows_attempts` from `flows_journal_events`.
 *
 * The operation never touches `flows_consensus_leases`: leases are
 * strategy-private state, not a fold materialization.
 *
 * @category persistence
 * @since 0.1.0
 */
export const rebuild: Effect.Effect<void, unknown, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter
  const rows = yield* sql<JournalRow>`
    SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
    FROM flows_journal_events
    WHERE event_type LIKE 'flows.run.%'
      OR event_type LIKE 'flows.attempt.%'
      OR event_type LIKE 'flows.consensus.%'
    ORDER BY run_id, seq
  `
  const entries = yield* Effect.forEach(rows, decodeEntry)
  const state = yield* foldEntries(entries)

  yield* writer.write(Effect.gen(function*() {
    yield* sql`PRAGMA defer_foreign_keys = ON`.withoutTransform
    yield* sql`DELETE FROM flows_attempts`
    yield* sql`DELETE FROM flows_runs`
    const runs = Array.from(state.runs.values()).sort((left, right) =>
      left.createdAtMs - right.createdAtMs || left.runId.localeCompare(right.runId)
    )
    for (const row of runs) {
      yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, started_at_ms, finished_at_ms,
          owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms,
          claim_host_id, claim_pid, claim_nonce, claimed_at_ms,
          parent_run_id, cancel_requested_at_ms, waiting_reason, waiting_wake_at_ms,
          waiting_token, state_json, lineage_id, round_ordinal
        ) VALUES (
          ${row.runId}, ${row.status}, ${row.createdAtMs}, ${row.startedAtMs}, ${row.finishedAtMs},
          ${row.owner?.hostId ?? null}, ${row.owner?.pid ?? null}, ${row.owner?.nonce ?? null}, ${row.heartbeatAtMs},
          ${row.claim?.hostId ?? null}, ${row.claim?.pid ?? null}, ${row.claim?.nonce ?? null}, ${row.claimedAtMs},
          ${row.parentRunId}, ${row.cancelRequestedAtMs}, ${row.waitingReason}, ${row.waitingWakeAtMs},
          ${row.waitingToken}, ${row.stateJson}, ${row.lineageId}, ${row.roundOrdinal}
        )
      `
    }
    const attempts = Array.from(state.attempts.values()).sort((left, right) =>
      left.runId.localeCompare(right.runId) ||
      left.stepKeyDigest.localeCompare(right.stepKeyDigest) ||
      left.attempt - right.attempt
    )
    for (const row of attempts) {
      yield* sql`
        INSERT INTO flows_attempts (
          run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
          heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
        ) VALUES (
          ${row.runId}, ${row.stepKeyDigest}, ${row.attempt}, ${row.state}, ${row.startedAtMs}, ${row.finishedAtMs},
          NULL, ${row.checkpointJson}, ${row.errorJson}, ${row.outcomeJson}, ${row.metaJson}
        )
      `
    }
  }))
})
