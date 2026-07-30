/**
 * Fenced run persistence and ownership compare-and-swap operations.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * The two-phase snapshot/claim/activation CAS and heartbeat fence are adapted
 * from smithers `packages/db` and `packages/engine`.
 *
 * @since 0.1.0
 */
import { Database } from "@smithers/database/Database"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { LivenessEvidence, OwnerId } from "./Ownership.ts"

/**
 * Stable run states understood by the durability layer.
 *
 * @since 0.1.0
 * @category models
 */
export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled"
])

/**
 * A stable run state.
 *
 * @since 0.1.0
 * @category models
 */
export type RunStatus = typeof RunStatus.Type

/**
 * Stable failure codes surfaced by `RunStore`.
 *
 * @since 0.1.0
 * @category errors
 */
export const RunStoreErrorCode = Schema.Literals([
  "invalid_run",
  "not_found_row",
  "constraint",
  "decode_failed",
  "persistence_failed",
  "unknown"
])

/**
 * A stable `RunStore` failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type RunStoreErrorCode = typeof RunStoreErrorCode.Type

/**
 * A normalized run persistence failure.
 *
 * Compare-and-swap competition is represented by successful outcome values,
 * never by this error channel.
 *
 * @since 0.1.0
 * @category errors
 */
export class RunStoreError extends Schema.TaggedErrorClass<RunStoreError>()("flows/journal/RunStoreError", {
  code: RunStoreErrorCode,
  method: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * The exact persisted fields guarded by a claim and its later activation.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunSnapshot {
  readonly status: RunStatus
  readonly owner: OwnerId | null
  readonly heartbeatAtMs: number | null
}

/**
 * A decoded row in `flows_runs`.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunRow extends RunSnapshot {
  readonly runId: string
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly claim: OwnerId | null
  readonly claimedAtMs: number | null
  readonly stateJson: string
}

/**
 * Result of acquiring claim columns for a later activation.
 *
 * @since 0.1.0
 * @category models
 */
export type ClaimOutcome =
  | { readonly _tag: "Claimed"; readonly claimedAtMs: number }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyClaimed" }
  | { readonly _tag: "HeartbeatFresh" }
  | { readonly _tag: "SnapshotChanged" }

/**
 * Result of claiming and activating ownership in one compare-and-swap.
 *
 * @since 0.1.0
 * @category models
 */
export type ClaimAndOwnOutcome =
  | { readonly _tag: "Activated" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyClaimed" }
  | { readonly _tag: "HeartbeatFresh" }
  | { readonly _tag: "SnapshotChanged" }

type ClaimLossOutcome = Exclude<ClaimOutcome, { readonly _tag: "Claimed" }>

/**
 * Result of activating a held claim.
 *
 * @since 0.1.0
 * @category models
 */
export type ActivateOutcome =
  | { readonly _tag: "Activated" }
  | { readonly _tag: "ClaimLost" }
  | { readonly _tag: "SnapshotChanged" }

/**
 * Result of clearing a held claim.
 *
 * @since 0.1.0
 * @category models
 */
export type AbandonClaimOutcome =
  | { readonly _tag: "Abandoned" }
  | { readonly _tag: "ClaimLost" }

/**
 * Result of clearing an exact stale claim after its claimant was proven dead.
 *
 * @since 0.1.0
 * @category models
 */
export type RecoverClaimOutcome =
  | { readonly _tag: "Recovered" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "ClaimFresh" }
  | { readonly _tag: "ClaimChanged" }
  | { readonly _tag: "LivenessUnconfirmed" }

/**
 * Result of a fenced ownership heartbeat.
 *
 * @since 0.1.0
 * @category models
 */
export type HeartbeatOutcome =
  | { readonly _tag: "Updated" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }

/**
 * Result of a fenced owned transition.
 *
 * @since 0.1.0
 * @category models
 */
export type TransitionOutcome =
  | { readonly _tag: "Transitioned" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }

/**
 * Fenced persistence operations for durable runs.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly create: (runId: string, stateJson: string) => Effect.Effect<void, RunStoreError>
  readonly get: (runId: string) => Effect.Effect<RunRow, RunStoreError>
  readonly claim: (
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number
  ) => Effect.Effect<ClaimOutcome, RunStoreError>
  /**
   * Claims and activates an exact snapshot atomically under the supplied owner.
   * Replacing a different running owner also requires matching liveness evidence.
   */
  readonly claimAndOwn: (
    runId: string,
    expected: RunSnapshot,
    owner: OwnerId,
    nowMs: number,
    evidence?: LivenessEvidence | undefined
  ) => Effect.Effect<ClaimAndOwnOutcome, RunStoreError>
  readonly activate: (
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number,
    expected: RunSnapshot
  ) => Effect.Effect<ActivateOutcome, RunStoreError>
  readonly abandonClaim: (
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number
  ) => Effect.Effect<AbandonClaimOutcome, RunStoreError>
  readonly recoverClaim: (
    runId: string,
    staleClaimant: OwnerId,
    claimedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<RecoverClaimOutcome, RunStoreError>
  readonly heartbeat: (
    runId: string,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<HeartbeatOutcome, RunStoreError>
  readonly transitionOwned: (
    runId: string,
    owner: OwnerId,
    toStatus: RunStatus,
    stateJson?: string | undefined
  ) => Effect.Effect<TransitionOutcome, RunStoreError>
  readonly steal: (
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<ClaimOutcome, RunStoreError>
}

/**
 * Service tag for fenced run persistence.
 *
 * @since 0.1.0
 * @category services
 */
export class RunStore extends Context.Service<RunStore, Service>()("flows/journal/RunStore") {}

const claimed = (claimedAtMs: number): ClaimOutcome => ({ _tag: "Claimed", claimedAtMs })
const notFound = { _tag: "NotFound" } as const
const alreadyClaimed = { _tag: "AlreadyClaimed" } as const
const heartbeatFresh = { _tag: "HeartbeatFresh" } as const
const snapshotChanged = { _tag: "SnapshotChanged" } as const
const activated = { _tag: "Activated" } as const
const claimLost = { _tag: "ClaimLost" } as const
const abandoned = { _tag: "Abandoned" } as const
const recovered = { _tag: "Recovered" } as const
const claimFresh = { _tag: "ClaimFresh" } as const
const claimChanged = { _tag: "ClaimChanged" } as const
const livenessUnconfirmed = { _tag: "LivenessUnconfirmed" } as const
const updated = { _tag: "Updated" } as const
const fenceLost = { _tag: "FenceLost" } as const
const transitioned = { _tag: "Transitioned" } as const

const heartbeatStaleAfterMs = 30_000
const terminalStatuses: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"])

const DatabaseRunRow = Schema.Struct({
  runId: Schema.String,
  status: RunStatus,
  createdAtMs: Schema.Number,
  startedAtMs: Schema.NullOr(Schema.Number),
  finishedAtMs: Schema.NullOr(Schema.Number),
  ownerHostId: Schema.NullOr(Schema.String),
  ownerPid: Schema.NullOr(Schema.Number),
  ownerNonce: Schema.NullOr(Schema.String),
  heartbeatAtMs: Schema.NullOr(Schema.Number),
  claimHostId: Schema.NullOr(Schema.String),
  claimPid: Schema.NullOr(Schema.Number),
  claimNonce: Schema.NullOr(Schema.String),
  claimedAtMs: Schema.NullOr(Schema.Number),
  stateJson: Schema.String
})

type DatabaseRunRow = typeof DatabaseRunRow.Type

const runStoreError = (
  method: string,
  code: RunStoreErrorCode,
  message: string,
  cause: unknown
): RunStoreError =>
  new RunStoreError({
    code,
    method,
    message: `${code}: RunStore.${method}: ${message}`,
    cause
  })

const persistenceError = (method: string, cause: unknown): RunStoreError => {
  const code = typeof cause === "object" && cause !== null && "code" in cause && cause.code === "constraint"
    ? "constraint"
    : "persistence_failed"
  return runStoreError(method, code, "database operation failed", cause)
}

const invalidRunError = (method: string, cause: unknown): RunStoreError =>
  runStoreError(method, "invalid_run", "run input is invalid", cause)

const isJsonString = (value: string): boolean =>
  Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(value)._tag === "Success"

const ownerFromColumns = (
  hostId: string | null,
  pid: number | null,
  nonce: string | null
): OwnerId | null | undefined => {
  if (hostId === null && pid === null && nonce === null) return null
  if (hostId !== null && pid !== null && nonce !== null) return { hostId, pid, nonce }
  return undefined
}

const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

const rowMatchesClaim = (row: DatabaseRunRow, claimant: OwnerId, claimedAtMs: number): boolean =>
  row.claimHostId === claimant.hostId &&
  row.claimPid === claimant.pid &&
  row.claimNonce === claimant.nonce &&
  row.claimedAtMs === claimedAtMs

const decodeRunRow = (method: string, input: unknown): Effect.Effect<RunRow, RunStoreError> =>
  Schema.decodeUnknownEffect(DatabaseRunRow)(input).pipe(
    Effect.mapError((cause) => runStoreError(method, "decode_failed", "could not decode flows_runs row", cause)),
    Effect.flatMap((row) => {
      const owner = ownerFromColumns(row.ownerHostId, row.ownerPid, row.ownerNonce)
      const claim = ownerFromColumns(row.claimHostId, row.claimPid, row.claimNonce)
      const invalidOwner = owner === undefined ||
        (owner === null && row.heartbeatAtMs !== null) ||
        (owner !== null && row.heartbeatAtMs === null) ||
        (row.status === "running" ? owner === null : owner !== null)
      const invalidClaim = claim === undefined ||
        (claim === null && row.claimedAtMs !== null) ||
        (claim !== null && row.claimedAtMs === null)
      if (invalidOwner || invalidClaim || !isJsonString(row.stateJson)) {
        return Effect.fail(
          runStoreError(method, "decode_failed", "flows_runs row violates ownership invariants", row)
        )
      }
      return Effect.succeed({
        runId: row.runId,
        status: row.status,
        createdAtMs: row.createdAtMs,
        startedAtMs: row.startedAtMs,
        finishedAtMs: row.finishedAtMs,
        owner,
        heartbeatAtMs: row.heartbeatAtMs,
        claim,
        claimedAtMs: row.claimedAtMs,
        stateJson: row.stateJson
      })
    })
  )

const selectRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql<DatabaseRunRow>`
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
      state_json AS "stateJson"
    FROM flows_runs
    WHERE run_id = ${runId}
  `

const classifyClaimLoss = (
  row: DatabaseRunRow | undefined,
  nowMs: number
): ClaimLossOutcome => {
  if (row === undefined) return notFound
  if (row.claimHostId !== null) return alreadyClaimed
  if (
    row.status === "running" &&
    row.heartbeatAtMs !== null &&
    row.heartbeatAtMs >= nowMs - heartbeatStaleAfterMs
  ) {
    return heartbeatFresh
  }
  return snapshotChanged
}

const evidenceMatches = (
  expected: RunSnapshot,
  claimant: OwnerId,
  nowMs: number,
  evidence: LivenessEvidence
): boolean =>
  expected.status === "running" &&
  expected.owner !== null &&
  evidenceMatchesOwner(expected.owner, claimant, nowMs, evidence)

const evidenceMatchesOwner = (
  expectedOwner: OwnerId,
  observer: OwnerId,
  nowMs: number,
  evidence: LivenessEvidence
): boolean => {
  if (!sameOwner(expectedOwner, evidence.expectedOwner) || evidence.checkedAtMs !== nowMs) return false
  return evidence.kind === "same-host-pid-dead"
    ? expectedOwner.hostId === observer.hostId
    : expectedOwner.hostId !== observer.hostId
}

/**
 * Constructs the production `RunStore` implementation.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, Database> = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql

  const write = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, RunStoreError, R> =>
    database.write(effect).pipe(Effect.mapError((cause) => persistenceError(method, cause)))

  const create = Effect.fn("flows/journal/RunStore.create")(
    (runId: string, stateJson: string): Effect.Effect<void, RunStoreError> => {
      if (runId.length === 0 || !isJsonString(stateJson)) {
        return Effect.fail(invalidRunError("create", { runId, stateJson }))
      }
      return Clock.currentTimeMillis.pipe(
        Effect.flatMap((createdAtMs) =>
          write(
            "create",
            sql`
            INSERT INTO flows_runs (
              run_id,
              status,
              created_at_ms,
              started_at_ms,
              finished_at_ms,
              owner_host_id,
              owner_pid,
              owner_nonce,
              heartbeat_at_ms,
              claim_host_id,
              claim_pid,
              claim_nonce,
              claimed_at_ms,
              state_json
            ) VALUES (
              ${runId},
              'pending',
              ${createdAtMs},
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              ${stateJson}
            )
          `.pipe(Effect.asVoid)
          )
        )
      )
    }
  )

  const get = Effect.fn("flows/journal/RunStore.get")((runId: string): Effect.Effect<RunRow, RunStoreError> =>
    write("get", selectRun(sql, runId)).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(runStoreError("get", "not_found_row", `run ${runId} was not found`, runId))
          : decodeRunRow("get", rows[0])
      )
    )
  )

  const claim = Effect.fn("flows/journal/RunStore.claim")((
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number
  ): Effect.Effect<ClaimOutcome, RunStoreError> =>
    write(
      "claim",
      Effect.gen(function*() {
        const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status <> 'running'
            AND status IN ('pending', 'suspended')
            AND status = ${expected.status}
            AND owner_host_id IS ${expected.owner?.hostId ?? null}
            AND owner_pid IS ${expected.owner?.pid ?? null}
            AND owner_nonce IS ${expected.owner?.nonce ?? null}
            AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
            AND (
              status <> 'running'
              OR heartbeat_at_ms IS NULL
              OR heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            )
          RETURNING run_id AS "runId"
        `
        if (rows.length > 0) return claimed(nowMs)
        const current = yield* selectRun(sql, runId)
        return classifyClaimLoss(current[0], nowMs)
      })
    )
  )

  const claimAndOwn = Effect.fn("flows/journal/RunStore.claimAndOwn")((
    runId: string,
    expected: RunSnapshot,
    owner: OwnerId,
    nowMs: number,
    evidence?: LivenessEvidence | undefined
  ): Effect.Effect<ClaimAndOwnOutcome, RunStoreError> => {
    const canReplaceExpectedOwner = expected.status !== "running" ||
      (expected.owner !== null && sameOwner(expected.owner, owner)) ||
      (evidence !== undefined && evidenceMatches(expected, owner, nowMs, evidence))

    if (!canReplaceExpectedOwner) {
      return write("claimAndOwn", selectRun(sql, runId)).pipe(
        Effect.map((current) => classifyClaimLoss(current[0], nowMs))
      )
    }

    return write(
      "claimAndOwn",
      Effect.gen(function*() {
        const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            status = 'running',
            started_at_ms = COALESCE(started_at_ms, ${nowMs}),
            finished_at_ms = NULL,
            owner_host_id = ${owner.hostId},
            owner_pid = ${owner.pid},
            owner_nonce = ${owner.nonce},
            heartbeat_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status IN ('pending', 'suspended', 'running')
            AND status = ${expected.status}
            AND owner_host_id IS ${expected.owner?.hostId ?? null}
            AND owner_pid IS ${expected.owner?.pid ?? null}
            AND owner_nonce IS ${expected.owner?.nonce ?? null}
            AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
            AND (
              status <> 'running'
              OR heartbeat_at_ms IS NULL
              OR heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            )
          RETURNING run_id AS "runId"
        `
        if (rows.length > 0) return activated
        const current = yield* selectRun(sql, runId)
        return classifyClaimLoss(current[0], nowMs)
      })
    )
  })

  const activate = Effect.fn("flows/journal/RunStore.activate")((
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number,
    expected: RunSnapshot
  ): Effect.Effect<ActivateOutcome, RunStoreError> =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((activatedAtMs) =>
        write(
          "activate",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
              UPDATE flows_runs
              SET
                status = 'running',
                started_at_ms = COALESCE(started_at_ms, ${activatedAtMs}),
                finished_at_ms = NULL,
                owner_host_id = ${claimant.hostId},
                owner_pid = ${claimant.pid},
                owner_nonce = ${claimant.nonce},
                heartbeat_at_ms = ${activatedAtMs},
                claim_host_id = NULL,
                claim_pid = NULL,
                claim_nonce = NULL,
                claimed_at_ms = NULL
              WHERE run_id = ${runId}
                AND status = ${expected.status}
                AND owner_host_id IS ${expected.owner?.hostId ?? null}
                AND owner_pid IS ${expected.owner?.pid ?? null}
                AND owner_nonce IS ${expected.owner?.nonce ?? null}
                AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
                AND claim_host_id = ${claimant.hostId}
                AND claim_pid = ${claimant.pid}
                AND claim_nonce = ${claimant.nonce}
                AND claimed_at_ms = ${claimedAtMs}
              RETURNING run_id AS "runId"
            `
            if (rows.length > 0) return activated

            const current = yield* selectRun(sql, runId)
            if (current[0] === undefined || !rowMatchesClaim(current[0], claimant, claimedAtMs)) return claimLost

            yield* sql`
              UPDATE flows_runs
              SET
                claim_host_id = NULL,
                claim_pid = NULL,
                claim_nonce = NULL,
                claimed_at_ms = NULL
              WHERE run_id = ${runId}
                AND claim_host_id = ${claimant.hostId}
                AND claim_pid = ${claimant.pid}
                AND claim_nonce = ${claimant.nonce}
                AND claimed_at_ms = ${claimedAtMs}
            `
            return snapshotChanged
          })
        )
      )
    )
  )

  const abandonClaim = Effect.fn("flows/journal/RunStore.abandonClaim")((
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number
  ): Effect.Effect<AbandonClaimOutcome, RunStoreError> =>
    write(
      "abandonClaim",
      Effect.map(
        sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = NULL,
            claim_pid = NULL,
            claim_nonce = NULL,
            claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${claimant.hostId}
            AND claim_pid = ${claimant.pid}
            AND claim_nonce = ${claimant.nonce}
            AND claimed_at_ms = ${claimedAtMs}
          RETURNING run_id AS "runId"
        `,
        (rows) => rows.length > 0 ? abandoned : claimLost
      )
    )
  )

  const recoverClaim = Effect.fn("flows/journal/RunStore.recoverClaim")((
    runId: string,
    staleClaimant: OwnerId,
    claimedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ): Effect.Effect<RecoverClaimOutcome, RunStoreError> => {
    if (!evidenceMatchesOwner(staleClaimant, observer, nowMs, evidence)) {
      return Effect.succeed(livenessUnconfirmed)
    }
    return write(
      "recoverClaim",
      Effect.gen(function*() {
        const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = NULL,
            claim_pid = NULL,
            claim_nonce = NULL,
            claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${staleClaimant.hostId}
            AND claim_pid = ${staleClaimant.pid}
            AND claim_nonce = ${staleClaimant.nonce}
            AND claimed_at_ms = ${claimedAtMs}
            AND claimed_at_ms < ${nowMs - heartbeatStaleAfterMs}
          RETURNING run_id AS "runId"
        `
        if (rows.length > 0) return recovered
        const current = yield* selectRun(sql, runId)
        if (current[0] === undefined) return notFound
        return rowMatchesClaim(current[0], staleClaimant, claimedAtMs) &&
            claimedAtMs >= nowMs - heartbeatStaleAfterMs
          ? claimFresh
          : claimChanged
      })
    )
  })

  const heartbeat = Effect.fn("flows/journal/RunStore.heartbeat")((
    runId: string,
    owner: OwnerId,
    nowMs: number
  ): Effect.Effect<HeartbeatOutcome, RunStoreError> =>
    write(
      "heartbeat",
      Effect.gen(function*() {
        const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET heartbeat_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status = 'running'
            AND owner_host_id = ${owner.hostId}
            AND owner_pid = ${owner.pid}
            AND owner_nonce = ${owner.nonce}
          RETURNING run_id AS "runId"
        `
        if (rows.length > 0) return updated
        const current = yield* selectRun(sql, runId)
        return current.length === 0 ? notFound : fenceLost
      })
    )
  )

  const transitionOwned = Effect.fn("flows/journal/RunStore.transitionOwned")((
    runId: string,
    owner: OwnerId,
    toStatus: RunStatus,
    stateJson?: string | undefined
  ): Effect.Effect<TransitionOutcome, RunStoreError> => {
    if (
      Schema.decodeUnknownResult(RunStatus)(toStatus)._tag === "Failure" ||
      (stateJson !== undefined && !isJsonString(stateJson))
    ) {
      return Effect.fail(invalidRunError("transitionOwned", { runId, toStatus, stateJson }))
    }
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((transitionedAtMs) =>
        write(
          "transitionOwned",
          Effect.gen(function*() {
            const rows = toStatus === "running"
              ? yield* sql<{ readonly runId: string }>`
                UPDATE flows_runs
                SET
                  status = 'running',
                  finished_at_ms = NULL,
                  state_json = COALESCE(${stateJson ?? null}, state_json)
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
                RETURNING run_id AS "runId"
              `
              : yield* sql<{ readonly runId: string }>`
                UPDATE flows_runs
                SET
                  status = ${toStatus},
                  finished_at_ms = ${terminalStatuses.has(toStatus) ? transitionedAtMs : null},
                  owner_host_id = NULL,
                  owner_pid = NULL,
                  owner_nonce = NULL,
                  heartbeat_at_ms = NULL,
                  claim_host_id = NULL,
                  claim_pid = NULL,
                  claim_nonce = NULL,
                  claimed_at_ms = NULL,
                  state_json = COALESCE(${stateJson ?? null}, state_json)
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
                RETURNING run_id AS "runId"
              `
            /* v8 ignore next -- both CAS outcomes are asserted; V8 reports a synthetic implicit branch */
            if (rows.length > 0) return transitioned
            const current = yield* selectRun(sql, runId)
            return current.length === 0 ? notFound : fenceLost
          })
        )
      )
    )
  })

  const steal = Effect.fn("flows/journal/RunStore.steal")((
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ): Effect.Effect<ClaimOutcome, RunStoreError> => {
    if (!evidenceMatches(expected, claimant, nowMs, evidence)) {
      return Effect.succeed(snapshotChanged)
    }
    const expectedOwner = expected.owner!
    return write(
      "steal",
      Effect.gen(function*() {
        const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status = ${expected.status}
            AND owner_host_id IS ${expectedOwner.hostId}
            AND owner_pid IS ${expectedOwner.pid}
            AND owner_nonce IS ${expectedOwner.nonce}
            AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
            AND heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
          RETURNING run_id AS "runId"
        `
        if (rows.length > 0) return claimed(nowMs)
        const current = yield* selectRun(sql, runId)
        return classifyClaimLoss(current[0], nowMs)
      })
    )
  })

  return RunStore.of({
    create,
    get,
    claim,
    claimAndOwn,
    activate,
    abandonClaim,
    recoverClaim,
    heartbeat,
    transitionOwned,
    steal
  })
})

/**
 * Constructs a stub `RunStore` whose direct operations fail and whose
 * compare-and-swap operations report typed losses until overridden.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) =>
    Effect.fail(runStoreError(method, "persistence_failed", "no run store in this environment", method))
  return RunStore.of({
    create: Effect.fn("flows/journal/RunStore.create")(() => unavailable("create")),
    get: Effect.fn("flows/journal/RunStore.get")(() => unavailable("get")),
    claim: Effect.fn("flows/journal/RunStore.claim")(() => Effect.succeed(notFound)),
    claimAndOwn: Effect.fn("flows/journal/RunStore.claimAndOwn")(() => Effect.succeed(notFound)),
    activate: Effect.fn("flows/journal/RunStore.activate")(() => Effect.succeed(claimLost)),
    abandonClaim: Effect.fn("flows/journal/RunStore.abandonClaim")(() => Effect.succeed(claimLost)),
    recoverClaim: Effect.fn("flows/journal/RunStore.recoverClaim")(() => Effect.succeed(notFound)),
    heartbeat: Effect.fn("flows/journal/RunStore.heartbeat")(() => Effect.succeed(notFound)),
    transitionOwned: Effect.fn("flows/journal/RunStore.transitionOwned")(() => Effect.succeed(notFound)),
    steal: Effect.fn("flows/journal/RunStore.steal")(() => Effect.succeed(notFound)),
    ...overrides
  })
}

/**
 * Provides a stub `RunStore`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<RunStore> =>
  Layer.succeed(RunStore, makeNoop(overrides))

/**
 * Provides the database-backed `RunStore`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<RunStore, never, Database> = Layer.effect(RunStore, make)
