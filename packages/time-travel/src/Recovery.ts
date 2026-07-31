/**
 * Startup recovery for incomplete rewind audits.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smithers/host/Jj"
import * as Journal from "@smithers/journal/Journal"
import type * as JournalEvent from "@smithers/journal/JournalEvent"
import type { LivenessEvidence, OwnerId } from "@smithers/journal/Ownership"
import * as RunStore from "@smithers/journal/RunStore"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"
import type { AuditDetail } from "./Rewind.ts"
import { error, TimeTravelError, type TimeTravelError as TimeTravelFailure } from "./TimeTravelError.ts"
import { type Audit, TimeTravelStore } from "./TimeTravelStore.ts"

/**
 * Recovery construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly owner: OwnerId
  readonly livenessEvidence?: (
    audit: Audit,
    row: RunStore.RunRow,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<LivenessEvidence | undefined, TimeTravelFailure>
}

/**
 * Outcome for one recovered audit.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome =
  | { readonly _tag: "Completed"; readonly auditId: string }
  | { readonly _tag: "RolledBack"; readonly auditId: string }
  | { readonly _tag: "Failed"; readonly auditId: string; readonly error: TimeTravelFailure }

interface Ownership {
  readonly row: RunStore.RunRow
  readonly owned: boolean
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isAuditDetail = (value: unknown): value is AuditDetail =>
  isObject(value) &&
  value.version === 1 &&
  typeof value.phase === "string" &&
  (value.originalStatus === "pending" || value.originalStatus === "suspended") &&
  typeof value.suffixCount === "number" &&
  Array.isArray(value.warnings) &&
  Array.isArray(value.cancelledChildren)

const runFailure = (operation: string, cause: RunStore.RunStoreError): TimeTravelFailure =>
  error(
    cause.code === "not_found_row" ? "not_found" : "unknown",
    `${operation} failed`,
    cause
  )

const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId &&
  left.pid === right.pid &&
  left.nonce === right.nonce

const acquire = (
  runs: RunStore.Service,
  audit: Audit,
  options: Options
): Effect.Effect<Ownership, TimeTravelFailure> =>
  Effect.gen(function*() {
    const row = yield* runs.get(audit.runId).pipe(
      Effect.mapError((cause) => runFailure("read recovery run", cause))
    )
    if (row.status === "suspended" && row.owner === null && row.claim === null) {
      return { row, owned: false }
    }
    if (row.status === "running" && row.owner !== null && sameOwner(row.owner, options.owner)) {
      return { row, owned: true }
    }
    if (row.claim !== null) {
      return yield* Effect.fail(error("busy", `run ${audit.runId} has an active claim`))
    }

    const nowMs = yield* Clock.currentTimeMillis
    const expected = snapshotOf(row)
    const claimed = row.status === "running"
      ? yield* Effect.gen(function*() {
        if (options.livenessEvidence === undefined) {
          return yield* Effect.fail(error("busy", `run ${audit.runId} is still owned`))
        }
        const evidence = yield* options.livenessEvidence(audit, row, options.owner, nowMs)
        if (evidence === undefined) {
          return yield* Effect.fail(error("busy", `run ${audit.runId} is still live`))
        }
        return yield* runs.steal(audit.runId, expected, options.owner, nowMs, evidence).pipe(
          Effect.mapError((cause) => runFailure("steal recovery run", cause))
        )
      })
      : yield* runs.claim(audit.runId, expected, options.owner, nowMs).pipe(
        Effect.mapError((cause) => runFailure("claim recovery run", cause))
      )
    if (claimed._tag !== "Claimed") {
      return yield* Effect.fail(error("busy", `run ${audit.runId} could not be claimed for recovery`))
    }
    const activated = yield* runs.activate(
      audit.runId,
      options.owner,
      claimed.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => runFailure("activate recovery run", cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(audit.runId, options.owner, claimed.claimedAtMs))
      return yield* Effect.fail(error("busy", `run ${audit.runId} lost its recovery claim`))
    }
    return { row, owned: true }
  })

const archiveCommitted = (
  journal: Journal.Service,
  audit: Audit,
  detail: AuditDetail
): Effect.Effect<boolean, TimeTravelFailure> => {
  if (detail.phase === "archive_committed" || detail.phase === "completed") {
    return Effect.succeed(true)
  }
  if (detail.suffixCount === 0) return Effect.succeed(false)
  return journal.entries({
    runId: audit.runId as JournalEvent.RunId,
    after: audit.frame.seq as JournalEvent.Seq,
    limit: 1
  }).pipe(
    Effect.map((page) => page.entries.length === 0),
    Effect.mapError((cause) => error("unknown", `could not inspect archive commit for ${audit.id}`, cause))
  )
}

const toFailure = (cause: Cause.Cause<unknown>): TimeTravelFailure => {
  const squashed = Cause.squash(cause)
  return squashed instanceof TimeTravelError
    ? squashed
    : error("unknown", squashed instanceof Error ? squashed.message : String(squashed), cause)
}

const terminalFailure = (
  store: TimeTravelStore["Service"],
  audit: Audit,
  detail: AuditDetail | undefined,
  failure: TimeTravelFailure
): Effect.Effect<Outcome, never> =>
  store.updateAudit(audit.id, {
    status: "failed",
    detail: detail === undefined
      ? {
        version: 1,
        phase: "terminal_failure",
        failure: failure.message
      }
      : {
        ...detail,
        phase: "terminal_failure",
        failure: failure.message
      }
  }).pipe(
    Effect.ignore,
    Effect.as({ _tag: "Failed" as const, auditId: audit.id, error: failure })
  )

const recoverOne = (
  audit: Audit,
  options: Options
): Effect.Effect<
  Outcome,
  never,
  EffectHandlerRegistry | Jj | Journal.Journal | RunStore.RunStore | TimeTravelStore
> =>
  Effect.gen(function*() {
    const store = yield* TimeTravelStore
    const runs = yield* RunStore.RunStore
    const journal = yield* Journal.Journal
    const detail = isAuditDetail(audit.detail) ? audit.detail : undefined
    if (detail === undefined) {
      return yield* terminalFailure(
        store,
        audit,
        undefined,
        error("unknown", `audit ${audit.id} has no recoverable protocol detail`)
      )
    }

    const recoveryExit = yield* Effect.exit(
      Effect.uninterruptible(
        Effect.gen(function*() {
          const ownership = yield* acquire(runs, audit, options)
          const committed = yield* archiveCommitted(journal, audit, detail)
          if (committed) {
            if (ownership.owned) {
              const suspended = yield* runs.transitionOwned(audit.runId, options.owner, "suspended").pipe(
                Effect.mapError((cause) => runFailure("finish recovered suspension", cause))
              )
              if (suspended._tag !== "Transitioned") {
                return yield* Effect.fail(
                  error("busy", `run ${audit.runId} lost its recovery fence`)
                )
              }
            }
            yield* store.updateAudit(audit.id, {
              status: "completed",
              detail: { ...detail, phase: "completed" }
            })
            return { _tag: "Completed" as const, auditId: audit.id }
          }

          if (detail.compensation !== undefined) {
            yield* Compensation.rollback(detail.compensation)
          }
          if (ownership.owned) {
            const restored = yield* runs.transitionOwned(
              audit.runId,
              options.owner,
              detail.originalStatus,
              ownership.row.stateJson
            ).pipe(
              Effect.mapError((cause) => runFailure("restore recovered run", cause))
            )
            if (restored._tag !== "Transitioned") {
              return yield* Effect.fail(
                error("busy", `run ${audit.runId} lost its rollback fence`)
              )
            }
          }
          yield* store.updateAudit(audit.id, {
            status: "failed",
            detail: {
              ...detail,
              phase: "rolled_back",
              compensation: undefined,
              failure: "startup recovery rolled back an uncommitted rewind"
            }
          })
          return { _tag: "RolledBack" as const, auditId: audit.id }
        })
      )
    )
    return Exit.isSuccess(recoveryExit)
      ? recoveryExit.value
      : yield* terminalFailure(store, audit, detail, toFailure(recoveryExit.cause))
  })

/**
 * Scans and resolves every pending rewind audit independently.
 *
 * A committed archive finishes the suspended transition. An uncommitted
 * rewind restores its jj snapshot and handler receipts. Per-audit failures are
 * returned as typed terminal outcomes and recorded on the same audit row;
 * recovery never invents a run status.
 *
 * @since 0.1.0
 * @category constructors
 */
export const recover = (
  options: Options
): Effect.Effect<
  ReadonlyArray<Outcome>,
  TimeTravelFailure,
  EffectHandlerRegistry | Jj | Journal.Journal | RunStore.RunStore | TimeTravelStore
> =>
  Effect.fn("Recovery.recover")(() =>
    Effect.gen(function*() {
      const store = yield* TimeTravelStore
      const audits = yield* store.pendingAudits()
      return yield* Effect.forEach(audits, (audit) => recoverOne(audit, options), {
        concurrency: 1
      })
    })
  )()
