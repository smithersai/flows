/**
 * Rebuildable run and attempt materializations from journal entries.
 *
 * Governing design: `docs/specs/Concepts/Run State Fold.md`.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { type EntriesPage, Journal, type JournalError } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as Projection from "@smthrs/journal/Projection"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
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

const stringOrNull = (value: unknown): string | null => typeof value === "string" ? value : null

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

/**
 * Merges one JSON column of an attempt mutation: an omitted key keeps
 * `current`, a carried key replaces it, and a value the writer failed to
 * pre-encode falls back to `onFailure` (`null` for the nullable columns,
 * `current` for required `metaJson`).
 */
const patchJson = <Fallback extends string | null>(
  payload: Record<string, unknown>,
  valueKey: string,
  jsonKey: string,
  current: Fallback,
  onFailure: Fallback
): string | Fallback => {
  if (!own(payload, valueKey)) return current
  const exact = payload[jsonKey]
  if (typeof exact === "string") return exact
  const encoded = encodeJson(payload[valueKey])
  return encoded === undefined ? onFailure : encoded
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
  const stateJson = typeof payload.stateJson === "string" ? payload.stateJson : row.stateJson
  // Lifecycle columns move only when the entry carries them: `status` and
  // `atMs` are present together exactly when the writer changed the
  // lifecycle columns. A waiting-payload write (`park`, `wake`) carries only
  // `waiting`, so it can never re-assert a status or re-stamp
  // `finished_at_ms` it did not write — the cancel-of-a-parked-run race of
  // `docs/specs/Concepts/Run State Fold.md`, round 3.
  const transitioned: RunFoldRow = status === undefined || atMs === null
    ? { ...row, stateJson }
    : status === "running"
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
      errorJson: patchJson(payload, "error", "errorJson", row.errorJson, null),
      outcomeJson: patchJson(payload, "outcome", "outcomeJson", row.outcomeJson, null),
      metaJson: patchJson(payload, "meta", "metaJson", row.metaJson, row.metaJson)
    })
    return
  }
  if (entry.eventType === "flows.attempt.patched") {
    state.attempts.set(key, {
      ...row,
      checkpointJson: patchJson(payload, "checkpoint", "checkpointJson", row.checkpointJson, null),
      errorJson: patchJson(payload, "error", "errorJson", row.errorJson, null),
      outcomeJson: patchJson(payload, "outcome", "outcomeJson", row.outcomeJson, null),
      metaJson: patchJson(payload, "meta", "metaJson", row.metaJson, row.metaJson)
    })
  }
}

const reduceSync = (state: State, entry: JournalEvent.Entry): State => {
  const payload = asRecord(entry.payload)
  if (payload === undefined) return state
  if (entry.eventType.startsWith("flows.run.")) {
    applyRunEvent(state, entry, payload)
    return state
  }
  if (entry.eventType.startsWith("flows.consensus.")) {
    applyConsensusEvent(state, entry, payload)
    return state
  }
  if (entry.eventType.startsWith("flows.attempt.")) {
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

/**
 * The `flows_runs` fold as a journal `Projection` over one run's entries:
 * `flows.run.*` seeds and moves the lifecycle columns and `flows.consensus.*`
 * (R6) moves the owner/claim mirror. Entries in other namespaces reduce to
 * the same state, so the projection composes with any run history.
 *
 * The reducer folds in place — each call constructs a fresh initial state,
 * so drive one projection value through one `Journal.project` replay.
 *
 * @category reducers
 * @since 0.1.0
 */
export const runProjection = (): Projection.Projection<Map<string, RunFoldRow>> =>
  Projection.make({
    name: "@smthrs/run-store/Fold/runs",
    initial: new Map<string, RunFoldRow>(),
    reduce: (runs, entry) =>
      Effect.sync(() => {
        const payload = asRecord(entry.payload)
        if (payload === undefined) return runs
        const state: State = { runs, attempts: new Map() }
        if (entry.eventType.startsWith("flows.run.")) {
          applyRunEvent(state, entry, payload)
        } else if (entry.eventType.startsWith("flows.consensus.")) {
          applyConsensusEvent(state, entry, payload)
        }
        return runs
      })
  })

/**
 * The `flows_attempts` fold as a journal `Projection` over one run's
 * `flows.attempt.*` entries.
 *
 * The reducer folds in place — each call constructs a fresh initial state,
 * so drive one projection value through one `Journal.project` replay.
 *
 * @category reducers
 * @since 0.1.0
 */
export const attemptProjection = (): Projection.Projection<Map<string, AttemptFoldRow>> =>
  Projection.make({
    name: "@smthrs/run-store/Fold/attempts",
    initial: new Map<string, AttemptFoldRow>(),
    reduce: (attempts, entry) =>
      Effect.sync(() => {
        const payload = asRecord(entry.payload)
        if (payload !== undefined && entry.eventType.startsWith("flows.attempt.")) {
          applyAttemptEvent({ runs: new Map(), attempts }, entry, payload)
        }
        return attempts
      })
  })

interface RunSnapshotSourceRow {
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

interface AttemptSnapshotSourceRow {
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

const snapshotOwner = (hostId: string | null, pid: number | null, nonce: string | null) =>
  hostId === null || pid === null || nonce === null ? null : { hostId, pid, nonce }

/**
 * Appends one run's snapshot set through the journal: one
 * `flows.run.snapshot` first, then one `flows.attempt.snapshot` per attempt
 * row, in a single transaction. The run snapshot leads so a run snapshot at
 * or after a compaction floor certifies that every attempt snapshot of its
 * set sequences at or after it too.
 *
 * This is the runtime half of the compaction barrier:
 * `SqlJournal.compact` refuses to drop fold-namespace history that no
 * `flows.run.snapshot` at or after the floor captures, and the automatic
 * `CompactionPolicy`'s snapshot hook is wired to this operation, run between
 * the checkpoint write and the compact call so the set sequences after the
 * floor (`docs/specs/Concepts/Run State Fold.md`). The same snapshot events
 * seed {@link rebuild} after a compaction, and the fold migration appends
 * them for pre-fold rows: one mechanism serves compaction, migration
 * backfill, and disaster rebuild.
 *
 * A run the tables do not know appends nothing: with no rows there is no
 * folded state to capture and no fold history for the barrier to hold.
 *
 * @category persistence
 * @since 0.1.0
 */
export const snapshot = (
  runId: string
): Effect.Effect<void, JournalError | SqlError.SqlError, Journal | SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const journal = yield* Journal
    const emit = (
      eventType: "flows.run.snapshot" | "flows.attempt.snapshot",
      payload: Record<string, unknown>
    ) =>
      journal.emitDurable(
        new JournalEvent.Input({
          runId: runId as JournalEvent.RunId,
          sourceId: "flows/run-store/fold/snapshot" as JournalEvent.SourceId,
          eventType,
          payload,
          meta: { lineageId: `${runId}/root` }
        })
      )
    yield* journal.transact(Effect.gen(function*() {
      const runs = yield* sql<RunSnapshotSourceRow>`
        SELECT
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
        WHERE run_id = ${runId}
      `
      const run = runs[0]
      if (run === undefined) return
      yield* emit("flows.run.snapshot", {
        status: run.status,
        createdAtMs: run.createdAtMs,
        startedAtMs: run.startedAtMs,
        finishedAtMs: run.finishedAtMs,
        owner: snapshotOwner(run.ownerHostId, run.ownerPid, run.ownerNonce),
        heartbeatAtMs: run.heartbeatAtMs,
        claim: snapshotOwner(run.claimHostId, run.claimPid, run.claimNonce),
        claimedAtMs: run.claimedAtMs,
        parentRunId: run.parentRunId,
        cancelRequestedAtMs: run.cancelRequestedAtMs,
        lineageId: run.lineageId,
        roundOrdinal: run.roundOrdinal,
        waiting: run.waitingReason === null
          ? null
          : {
            reason: run.waitingReason,
            wakeAt: run.waitingWakeAtMs,
            token: run.waitingToken
          },
        stateJson: run.stateJson
      })
      const attempts = yield* sql<AttemptSnapshotSourceRow>`
        SELECT
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
        WHERE run_id = ${runId}
        ORDER BY step_key_digest, attempt
      `
      for (const row of attempts) {
        yield* emit("flows.attempt.snapshot", {
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
      }
    }))
  })

const rebuildPageSize = 256

/**
 * Replays one run's committed entries into the fold state through
 * `Journal.project`.
 *
 * A compacted run resyncs exactly as the journal's read contract
 * prescribes: the first page's `compacted` refusal carries the compaction
 * floor, and re-reading from just below it returns the surviving history.
 * `SqlJournal.compact` refuses to truncate fold history that no
 * `flows.run.snapshot` at or after the floor captures, so the surviving
 * history always seeds the fold completely — either the events are still
 * there, or the snapshot that subsumes them is.
 */
const foldRun = (
  journal: Journal["Service"],
  runId: JournalEvent.RunId,
  state: State
): Effect.Effect<void, JournalError> =>
  Effect.gen(function*() {
    let cursor: number | undefined = undefined
    let projectAfter: number | undefined = undefined
    let entryCount = 0
    let hasMore = true
    while (hasMore) {
      const first: number | undefined = cursor
      const page: EntriesPage = yield* journal.entries({
        runId,
        /* v8 ignore next -- only a run above the 256-entry page size sets the cursor; the conformance histories fit one page, and pagination is the journal read contract pinned in `@smthrs/journal`'s own suite. */
        ...(first === undefined ? {} : { after: first as JournalEvent.Seq }),
        limit: rebuildPageSize
      }).pipe(
        Effect.catch((cause) => {
          const checkpointSeq = cause.checkpointSeq
          /* v8 ignore next 2 -- the compacted arm is covered by the compaction rebuild tests; the fallthrough re-raising a non-compaction failure (or a compaction refusal past the first page, which the floor guard makes unrepresentable) is defensive. */
          return first === undefined && cause.code === "compacted" && checkpointSeq !== undefined
            ? Effect.gen(function*() {
              projectAfter = checkpointSeq - 1
              return yield* journal.entries({
                runId,
                after: projectAfter as JournalEvent.Seq,
                limit: rebuildPageSize
              })
            })
            : Effect.fail(cause)
        })
      )
      entryCount += page.entries.length
      const last = page.entries.at(-1)
      /* v8 ignore next -- an empty page is unreachable: `Journal.runs` lists only runs with committed entries, and a page with `hasMore` is never empty. */
      if (last !== undefined) {
        cursor = last.seq
      }
      hasMore = page.hasMore
    }
    const streamOptions = {
      runId,
      ...(projectAfter === undefined ? {} : { afterSequence: projectAfter as JournalEvent.Seq })
    }
    const runStates = yield* journal.project(runProjection(), streamOptions).pipe(
      Stream.take(entryCount + 1),
      Stream.runCollect
    )
    const attemptStates = yield* journal.project(attemptProjection(), streamOptions).pipe(
      Stream.take(entryCount + 1),
      Stream.runCollect
    )
    /* v8 ignore next -- `Journal.project` emits the projection's initial state before the first entry, so a finite replay always collects at least one state. */
    const runs = runStates.at(-1) ?? new Map<string, RunFoldRow>()
    /* v8 ignore next -- `Journal.project` emits the projection's initial state before the first entry, so a finite replay always collects at least one state. */
    const attempts = attemptStates.at(-1) ?? new Map<string, AttemptFoldRow>()
    for (const [key, row] of runs) state.runs.set(key, row)
    for (const [key, row] of attempts) state.attempts.set(key, row)
  })

/**
 * Rebuilds `flows_runs` and `flows_attempts` from the journal.
 *
 * Runs are enumerated through `Journal.runs` and replayed through
 * {@link runProjection} / {@link attemptProjection} via `Journal.project`,
 * never by selecting from the event table, which is `@smthrs/journal`'s
 * private schema. The tables are truncated and repopulated inside one
 * `DurableWriter` transaction.
 *
 * The operation never touches `flows_consensus_leases`: leases are
 * strategy-private state, not a fold materialization.
 *
 * @category persistence
 * @since 0.1.0
 */
export const rebuild: Effect.Effect<void, unknown, Journal | DurableWriter | SqlClient.SqlClient> = Effect.gen(
  function*() {
    const sql = yield* SqlClient.SqlClient
    const writer = yield* DurableWriter
    const journal = yield* Journal
    const runIds = yield* journal.runs
    const state = initial()
    for (const runId of runIds) {
      yield* foldRun(journal, runId, state)
    }

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
  }
)
