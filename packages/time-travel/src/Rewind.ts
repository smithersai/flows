/**
 * Ownership-fenced, crash-recoverable rewind protocol.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Compensation from "./Compensation.ts"
import * as EffectBoundary from "./EffectBoundary.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"
import { Frame, type LineageEdge } from "./Frame.ts"
import { error, TimeTravelError, type TimeTravelError as TimeTravelFailure } from "./TimeTravelError.ts"
import { ArchiveResult, type Audit, TimeTravelStore } from "./TimeTravelStore.ts"

/**
 * The eight fault-injection points pinned by the rewind parity suite.
 *
 * Every hook runs after the durable audit exists and before the atomic archive
 * commit. A failure therefore exercises rollback while preserving the audit.
 *
 * @since 0.1.0
 * @category models
 */
export const RewindStep = Schema.Literals([
  "claim-run",
  "rate-limit",
  "write-audit",
  "load-suffix",
  "assess-boundary",
  "compensate-effects",
  "restore-workspace",
  "archive-and-truncate"
])
/** @since 0.1.0 @category models */
export type RewindStep = typeof RewindStep.Type

/**
 * A deterministic rate-limit decision recorded on the audit row.
 *
 * @since 0.1.0
 * @category models
 */
export const RateLimitDecision = Schema.Struct({
  allowed: Schema.Boolean,
  detail: Schema.optionalKey(Schema.Unknown)
})
/** @since 0.1.0 @category models */
export type RateLimitDecision = typeof RateLimitDecision.Type

/**
 * Child handling policy for detached runs crossed by the rewind.
 *
 * @since 0.1.0
 * @category models
 */
export const DetachedChildPolicy = Schema.Literals(["block", "cancel"])
/** @since 0.1.0 @category models */
export type DetachedChildPolicy = typeof DetachedChildPolicy.Type

/**
 * A warning disclosed for a terminal detached child that survives truncation.
 *
 * @since 0.1.0
 * @category models
 */
export const DetachedChildWarning = Schema.Struct({
  childRunId: Schema.NonEmptyString,
  parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.String
})
/** @since 0.1.0 @category models */
export type DetachedChildWarning = typeof DetachedChildWarning.Type

/**
 * Crash-recovery detail persisted on the audit row.
 *
 * @since 0.1.0
 * @category models
 */
export const AuditDetail = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals([
    "audit_written",
    "preflight_complete",
    "compensated",
    "archive_committed",
    "completed",
    "rolled_back",
    "terminal_failure"
  ]),
  originalStatus: Schema.Literals(["pending", "suspended"]),
  suffixCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  suffixTailSeq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  targetChangeId: Schema.optionalKey(Schema.NonEmptyString),
  compensation: Schema.optionalKey(Compensation.Result),
  warnings: Schema.Array(DetachedChildWarning),
  cancelledChildren: Schema.Array(Schema.NonEmptyString),
  failure: Schema.optionalKey(Schema.String)
})
/** @since 0.1.0 @category models */
export type AuditDetail = typeof AuditDetail.Type

/**
 * Rewind construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly runId: string
  readonly frame: Frame
  readonly owner: OwnerId
  readonly auditId?: string | undefined
  readonly pageSize?: number | undefined
  readonly detachedChildPolicy?: DetachedChildPolicy | undefined
  readonly rateLimit?: (options: {
    readonly runId: string
    readonly frame: Frame
    readonly nowMs: number
  }) => Effect.Effect<RateLimitDecision, TimeTravelFailure> | undefined
  readonly childLivenessEvidence?: (
    childRunId: string,
    row: RunStore.RunRow,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<LivenessEvidence | undefined, TimeTravelFailure>
  readonly hooks?: {
    readonly beforeStep?: (
      step: RewindStep
    ) => Effect.Effect<void, unknown>
  } | undefined
}

/**
 * Successful rewind outcome.
 *
 * @since 0.1.0
 * @category models
 */
export const Result = Schema.Struct({
  auditId: Schema.NonEmptyString,
  frame: Frame,
  archive: ArchiveResult,
  assessments: Schema.Array(Compensation.Assessment),
  warnings: Schema.Array(DetachedChildWarning),
  cancelledChildren: Schema.Array(Schema.NonEmptyString)
})
/** @since 0.1.0 @category models */
export type Result = typeof Result.Type

interface ClaimedRun {
  readonly row: RunStore.RunRow & { readonly status: "pending" | "suspended" }
  readonly claimedAtMs: number
}

interface ChildPlan {
  readonly edge: LineageEdge
  readonly row: RunStore.RunRow
}

const runStoreFailure = (
  operation: string,
  cause: RunStore.RunStoreError
): TimeTravelFailure =>
  error(
    cause.code === "not_found_row" ? "not_found" : "unknown",
    `${operation} failed`,
    cause
  )

const readSuffix = (
  journal: Journal.Service,
  runId: string,
  frame: Frame,
  pageSize: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, TimeTravelFailure> =>
  Effect.gen(function*() {
    const entries: Array<JournalEvent.Entry> = []
    let after = frame.seq as JournalEvent.Seq
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        after,
        limit: pageSize
      }).pipe(
        Effect.mapError((cause) => error("unknown", `could not read suffix for ${runId}`, cause))
      )
      entries.push(...page.entries)
      if (!page.hasMore || page.entries.length === 0) return entries
      after = page.entries.at(-1)!.seq
    }
  })

const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const claimRun = (
  runs: RunStore.Service,
  options: Options,
  nowMs: number
): Effect.Effect<ClaimedRun, TimeTravelFailure> =>
  Effect.gen(function*() {
    const row = yield* runs.get(options.runId).pipe(
      Effect.mapError((cause) => runStoreFailure("read run", cause))
    )
    if (row.status !== "pending" && row.status !== "suspended") {
      return yield* Effect.fail(error("busy", `run ${options.runId} is not available for rewind`))
    }
    const rewindableRow: ClaimedRun["row"] = { ...row, status: row.status }
    if (row.owner !== null || row.claim !== null) {
      return yield* Effect.fail(error("busy", `run ${options.runId} is not available for rewind`))
    }
    const expected = snapshotOf(row)
    const outcome = yield* runs.claim(options.runId, expected, options.owner, nowMs).pipe(
      Effect.mapError((cause) => runStoreFailure("claim run", cause))
    )
    if (outcome._tag === "NotFound") {
      return yield* Effect.fail(error("not_found", `run ${options.runId} was not found`))
    }
    if (outcome._tag !== "Claimed") {
      return yield* Effect.fail(error("busy", `run ${options.runId} lost the rewind claim`))
    }
    const activated = yield* runs.activate(
      options.runId,
      options.owner,
      outcome.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => runStoreFailure("activate rewind claim", cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(options.runId, options.owner, outcome.claimedAtMs))
      return yield* Effect.fail(error("busy", `run ${options.runId} lost the rewind activation`))
    }
    return { row: rewindableRow, claimedAtMs: outcome.claimedAtMs }
  })

const runHook = (
  options: Options,
  step: RewindStep
): Effect.Effect<void, TimeTravelFailure> => {
  const hook = options.hooks?.beforeStep
  return hook === undefined
    ? Effect.void
    : hook(step).pipe(
      Effect.mapError((cause) => error("unknown", `rewind failed at ${step}`, cause))
    )
}

const terminal = (status: RunStore.RunStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

const assessChildren = (
  runs: RunStore.Service,
  edges: ReadonlyArray<LineageEdge>,
  policy: DetachedChildPolicy
): Effect.Effect<{
  readonly warnings: ReadonlyArray<DetachedChildWarning>
  readonly cancellable: ReadonlyArray<ChildPlan>
}, TimeTravelFailure> =>
  Effect.gen(function*() {
    const warnings: Array<DetachedChildWarning> = []
    const cancellable: Array<ChildPlan> = []
    for (const edge of edges) {
      const child = yield* Effect.option(
        runs.get(edge.childRunId).pipe(
          Effect.mapError((cause) => runStoreFailure("read detached child", cause))
        )
      )
      if (child._tag === "None") {
        warnings.push({
          childRunId: edge.childRunId,
          parentSeq: edge.parentSeq,
          reason: "Detached child evidence is missing; the orphaned lineage edge remains disclosed."
        })
        continue
      }
      if (terminal(child.value.status)) {
        warnings.push({
          childRunId: edge.childRunId,
          parentSeq: edge.parentSeq,
          reason: `Terminal detached child ${edge.childRunId} survives as an orphaned lineage edge.`
        })
        continue
      }
      if (policy === "block") {
        return yield* Effect.fail(
          error("live_child", `live detached child ${edge.childRunId} blocks rewind`)
        )
      }
      cancellable.push({ edge, row: child.value })
    }
    return { warnings, cancellable }
  })

const cancelChild = (
  runs: RunStore.Service,
  options: Options,
  plan: ChildPlan
): Effect.Effect<void, TimeTravelFailure> =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis
    const childOwner: OwnerId = {
      ...options.owner,
      nonce: `${options.owner.nonce}:rewind-child:${plan.edge.childRunId}`
    }
    const expected = snapshotOf(plan.row)
    const claim = plan.row.status === "running"
      ? yield* Effect.gen(function*() {
        if (options.childLivenessEvidence === undefined) {
          return yield* Effect.fail(
            error("live_child", `child ${plan.edge.childRunId} is running and has no cancellation evidence`)
          )
        }
        const evidence = yield* options.childLivenessEvidence(
          plan.edge.childRunId,
          plan.row,
          childOwner,
          nowMs
        )
        if (evidence === undefined) {
          return yield* Effect.fail(
            error("live_child", `child ${plan.edge.childRunId} is still live`)
          )
        }
        return yield* runs.steal(plan.edge.childRunId, expected, childOwner, nowMs, evidence).pipe(
          Effect.mapError((cause) => runStoreFailure("claim detached child", cause))
        )
      })
      : yield* runs.claim(plan.edge.childRunId, expected, childOwner, nowMs).pipe(
        Effect.mapError((cause) => runStoreFailure("claim detached child", cause))
      )

    if (claim._tag !== "Claimed") {
      return yield* Effect.fail(
        error("live_child", `could not claim detached child ${plan.edge.childRunId} for cancellation`)
      )
    }
    const activated = yield* runs.activate(
      plan.edge.childRunId,
      childOwner,
      claim.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => runStoreFailure("activate detached child", cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(plan.edge.childRunId, childOwner, claim.claimedAtMs))
      return yield* Effect.fail(
        error("live_child", `detached child ${plan.edge.childRunId} lost its cancellation claim`)
      )
    }
    const cancelled = yield* runs.transitionOwned(
      plan.edge.childRunId,
      childOwner,
      "cancelled"
    ).pipe(
      Effect.mapError((cause) => runStoreFailure("cancel detached child", cause))
    )
    if (cancelled._tag !== "Transitioned") {
      return yield* Effect.fail(
        error("live_child", `detached child ${plan.edge.childRunId} lost its cancellation fence`)
      )
    }
  })

const toFailure = (cause: Cause.Cause<unknown>): TimeTravelFailure => {
  const squashed = Cause.squash(cause)
  return squashed instanceof TimeTravelError
    ? squashed
    : error("unknown", squashed instanceof Error ? squashed.message : String(squashed), cause)
}

const initialDetail = (
  originalStatus: "pending" | "suspended"
): AuditDetail => ({
  version: 1,
  phase: "audit_written",
  originalStatus,
  suffixCount: 0,
  warnings: [],
  cancelledChildren: []
})

/**
 * Rewinds a run through the single public ownership CAS.
 *
 * Handler resolution, cache checks, and detached-child classification all
 * complete before compensation starts. The child-inclusive archive/truncate
 * is the final journal mutation and its commit becomes the recovery commit
 * point; a crash after that point is completed by `Recovery`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const rewind = (
  options: Options
): Effect.Effect<
  Result,
  TimeTravelFailure,
  | CacheStore.CacheStore
  | EffectHandlerRegistry
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | TimeTravelStore
> =>
  Effect.fn("Rewind.rewind")(() =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const journal = yield* Journal.Journal
      const store = yield* TimeTravelStore
      const nowMs = yield* Clock.currentTimeMillis
      const auditId = options.auditId ??
        `${options.runId}:rewind:${options.owner.nonce}:${nowMs}:${options.frame.seq}`

      let claimed: ClaimedRun | undefined
      let archiveCommitted = false
      let compensation: Compensation.Result = { handlerReceipts: [] }
      let detail: AuditDetail | undefined
      const cancelledChildren: Array<string> = []

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const protocol = restore(
            Effect.gen(function*() {
              claimed = yield* claimRun(runs, options, nowMs)
              const originalStatus = claimed.row.status

              const rateLimit = options.rateLimit?.({
                runId: options.runId,
                frame: options.frame,
                nowMs
              }) ?? Effect.succeed({ allowed: true } as const)
              const decision = yield* rateLimit
              const auditDetail = initialDetail(originalStatus)
              const audit: Audit = {
                id: auditId,
                runId: options.runId,
                frame: options.frame,
                status: "in_progress",
                rateLimit: "detail" in decision && decision.detail !== undefined
                  ? decision.detail
                  : { allowed: decision.allowed, checkedAtMs: nowMs },
                detail: auditDetail
              }
              yield* store.writeAudit(audit)
              detail = auditDetail

              yield* runHook(options, "claim-run")
              yield* runHook(options, "rate-limit")
              if (!decision.allowed) {
                return yield* Effect.fail(error("rate_limited", `rewind rate limit exceeded for ${options.runId}`))
              }
              yield* runHook(options, "write-audit")

              const snapshot = yield* store.snapshotAt(options.runId, options.frame)
              const descendants = yield* store.descendants(options.runId, options.frame)
              const suffix = yield* readSuffix(
                journal,
                options.runId,
                options.frame,
                options.pageSize ?? 100
              )
              const effects = EffectBoundary.fromEntries(suffix)
              yield* runHook(options, "load-suffix")

              const childAssessment = yield* assessChildren(
                runs,
                descendants.detached,
                options.detachedChildPolicy ?? "block"
              )
              const plan = yield* Compensation.assess(effects, snapshot?.changeId)
              const blocking = plan.assessments.filter(
                (assessment) => assessment.classification === "blocking"
              )
              if (blocking.length > 0) {
                return yield* Effect.fail(
                  error("irreversible", `rewind is blocked by ${blocking.length} effect(s)`, blocking)
                )
              }
              detail = {
                ...detail,
                phase: "preflight_complete",
                suffixCount: suffix.length,
                ...(suffix.at(-1) === undefined ? {} : { suffixTailSeq: suffix.at(-1)!.seq }),
                ...(snapshot === undefined ? {} : { targetChangeId: snapshot.changeId }),
                warnings: childAssessment.warnings
              }
              yield* store.updateAudit(auditId, { detail })
              yield* runHook(options, "assess-boundary")

              /**
               * Cancelling a detached child is terminal and happens before the
               * archive commit point, so it is the one rewind mutation a
               * rollback cannot undo. Each cancellation is therefore recorded
               * on the audit as it happens: the rollback path spreads the
               * current `detail`, and an undisclosed irreversible side effect
               * is worse than a slower protocol.
               */
              for (
                const child of [...childAssessment.cancellable].sort(
                  (left, right) => right.edge.parentSeq - left.edge.parentSeq
                )
              ) {
                yield* cancelChild(runs, options, child)
                cancelledChildren.push(child.edge.childRunId)
                detail = { ...detail, cancelledChildren: [...cancelledChildren] }
                yield* store.updateAudit(auditId, { detail })
              }

              const handlerReceipts = yield* Compensation.compensate(plan)
              compensation = { handlerReceipts }
              yield* runHook(options, "compensate-effects")

              compensation = yield* Compensation.restoreWorkspace(plan, handlerReceipts)
              yield* runHook(options, "restore-workspace")
              detail = {
                ...detail,
                phase: "compensated",
                compensation,
                cancelledChildren: [...cancelledChildren]
              }
              yield* store.updateAudit(auditId, { detail })

              yield* runHook(options, "archive-and-truncate")
              const archive = yield* store.archiveAndTruncate(
                options.runId,
                options.frame,
                Compensation.toStoreReceipts(auditId, compensation)
              )
              archiveCommitted = true
              detail = { ...detail, phase: "archive_committed" }
              yield* store.updateAudit(auditId, { detail })

              const suspended = yield* runs.transitionOwned(
                options.runId,
                options.owner,
                "suspended"
              ).pipe(
                Effect.mapError((cause) => runStoreFailure("suspend rewound run", cause))
              )
              if (suspended._tag !== "Transitioned") {
                return yield* Effect.fail(
                  error("busy", `run ${options.runId} lost ownership before suspension`)
                )
              }

              detail = { ...detail, phase: "completed" }
              yield* store.updateAudit(auditId, {
                status: "completed",
                detail
              })
              return {
                auditId,
                frame: options.frame,
                archive,
                assessments: plan.assessments,
                warnings: childAssessment.warnings,
                cancelledChildren: [...cancelledChildren]
              }
            })
          )

          const protocolExit = yield* Effect.exit(protocol)
          if (Exit.isSuccess(protocolExit)) return protocolExit.value
          const failure = toFailure(protocolExit.cause)

          if (!archiveCommitted) {
            const rollbackExit = yield* Effect.exit(Compensation.rollback(compensation))
            if (claimed !== undefined) {
              const restored = yield* runs.transitionOwned(
                options.runId,
                options.owner,
                claimed.row.status,
                claimed.row.stateJson
              ).pipe(
                Effect.mapError((cause) => runStoreFailure("restore run state", cause)),
                Effect.exit
              )
              if (Exit.isFailure(restored) && detail === undefined) {
                yield* Effect.ignore(runs.abandonClaim(options.runId, options.owner, claimed.claimedAtMs))
              }
            }
            if (detail !== undefined) {
              const currentDetail = detail
              const rollbackFailure = Exit.isFailure(rollbackExit) ? Cause.squash(rollbackExit.cause) : undefined
              // Child cancellation has no inverse, so a "rolled back" rewind
              // still owns that residue and has to name it.
              const residue = cancelledChildren.length === 0
                ? ""
                : `; ${cancelledChildren.length} detached child run(s) stay cancelled: ${cancelledChildren.join(", ")}`
              const failureMessage = (rollbackFailure === undefined
                ? failure.message
                : `${failure.message}; rollback failed: ${String(rollbackFailure)}`) + residue
              const { compensation: _, ...rolledBack } = currentDetail
              detail = {
                ...rolledBack,
                phase: rollbackFailure === undefined ? "rolled_back" : "terminal_failure",
                cancelledChildren: [...cancelledChildren],
                failure: failureMessage
              }
              yield* Effect.ignore(
                store.updateAudit(auditId, {
                  status: "failed",
                  detail
                })
              )
              if (Exit.isFailure(rollbackExit)) {
                return yield* Effect.fail(
                  error("compensation_failed", failureMessage, {
                    rewind: protocolExit.cause,
                    rollback: rollbackExit.cause
                  })
                )
              }
            }
          }

          return yield* Effect.fail(failure)
        })
      )
    })
  )()
