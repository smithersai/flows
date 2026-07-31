/**
 * Durable activity dispatch at the engine encoded seam.
 *
 * Governing designs: `docs/specs/Concepts/Run Ownership.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { AttemptStore, CacheStore, Journal, type Ownership, RunStore } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as StepBoundary from "../StepBoundary.ts"
import * as JournalRecords from "./JournalRecords.ts"

/** @since 0.1.0 @category models */
export type Tier = "sealed" | "compensable" | "irreversible"

/** @since 0.1.0 @category models */
export type BoundaryMetadata = StepBoundary.Descriptor

/** @since 0.1.0 @category models */
export interface ActivityInput {
  readonly activity: unknown
  readonly attempt: number
  readonly key: string
  readonly tier: Tier
  readonly metadata?: BoundaryMetadata | undefined
}

/** @since 0.1.0 @category errors */
export class AttemptSuspended extends Schema.TaggedErrorClass<AttemptSuspended>()(
  "flows/engine-store/AttemptSuspended",
  {
    code: Schema.Literal("attempt_suspended"),
    runId: Schema.String,
    keyDigest: Schema.String,
    attempt: Schema.Int
  }
) {}

/** @since 0.1.0 @category errors */
export class IrreversibleRetryRequiresIdempotencyKey
  extends Schema.TaggedErrorClass<IrreversibleRetryRequiresIdempotencyKey>()(
    "flows/engine-store/IrreversibleRetryRequiresIdempotencyKey",
    {
      code: Schema.Literal("irreversible_retry_requires_idempotency_key"),
      key: Schema.String
    }
  )
{}

/** @since 0.1.0 @category errors */
export class AttemptAdmissionRejected extends Schema.TaggedErrorClass<AttemptAdmissionRejected>()(
  "flows/engine-store/AttemptAdmissionRejected",
  {
    code: Schema.Literal("attempt_admission_rejected"),
    keyDigest: Schema.String,
    outcome: Schema.String
  }
) {}

/** @since 0.1.0 @category models */
export interface Dependencies {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly sourceId: string
  readonly execute: (input: ActivityInput) => Effect.Effect<unknown, unknown>
  readonly idempotencyKey?: string | undefined
}

const AttemptMeta = Schema.Struct({
  tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
  boundary: Schema.optional(StepBoundary.BoundaryEvidence),
  snapshotId: Schema.optional(Schema.String)
})

type AttemptMeta = typeof AttemptMeta.Type

const decodeMeta = (value: unknown): AttemptMeta | undefined => {
  const decoded = Schema.decodeUnknownResult(AttemptMeta)(value)
  return decoded._tag === "Success" ? decoded.success : undefined
}

const source = (deps: Dependencies) => ({ runId: deps.runId, sourceId: deps.sourceId })

/**
 * Constructs the encoded activity executor. The activity itself stays opaque;
 * the supplied dispatcher is the only physical execution point.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (deps: Dependencies) =>
  Effect.fn("ActivityPersistence.execute")((input: ActivityInput) =>
    Effect.gen(function*() {
      const attempts = yield* AttemptStore.AttemptStore
      const cache = yield* CacheStore.CacheStore
      const journal = yield* Journal.Journal
      const runs = yield* RunStore.RunStore
      const keyDigest = Digest.digest(input.key)
      const attemptId = { runId: deps.runId, stepKeyDigest: keyDigest, attempt: input.attempt }
      const fencedAtMs = yield* Clock.currentTimeMillis
      const heartbeat = yield* runs.heartbeat(deps.runId, deps.owner, fencedAtMs)
      if (heartbeat._tag !== "Updated") return yield* Effect.interrupt

      if (input.tier === "irreversible" && input.attempt > 1 && deps.idempotencyKey === undefined) {
        return yield* Effect.fail(
          new IrreversibleRetryRequiresIdempotencyKey({
            code: "irreversible_retry_requires_idempotency_key",
            key: input.key
          })
        )
      }

      const cacheable = input.tier === "sealed" && input.metadata?.boundaryMode === "hard"
      if (cacheable) {
        const cached = yield* cache.get(keyDigest)
        if (Option.isSome(cached)) {
          const meta = decodeMeta(cached.value.meta)
          if (meta?.tier === "sealed" && meta.boundary !== undefined && meta.boundary.deviation === undefined) {
            const boundary = yield* StepBoundary.StepBoundary
            yield* boundary.replayOutputs(meta.boundary)
            yield* journal.emit(JournalRecords.cacheProvenance(source(deps), {
              keyDigest,
              recordedRunId: cached.value.recordedRunId,
              recordedEventSeq: cached.value.recordedEventSeq
            }))
            return cached.value.result
          }
        }
      }

      const existing = yield* attempts.get(attemptId)
      if (Option.isSome(existing)) {
        const row = existing.value
        if (row.state === "succeeded") {
          const meta = decodeMeta(row.meta)
          if (meta?.boundary !== undefined) {
            const boundary = yield* StepBoundary.StepBoundary
            yield* boundary.replayOutputs(meta.boundary)
          }
          return row.outcome
        }
        if (row.state === "suspended") {
          return yield* Effect.fail(
            new AttemptSuspended({
              code: "attempt_suspended",
              runId: deps.runId,
              keyDigest,
              attempt: input.attempt
            })
          )
        }
      }

      const now = yield* Clock.currentTimeMillis
      const initialMeta: AttemptMeta = { tier: input.tier }
      const put = yield* attempts.put(
        { ...attemptId, state: "running", startedAtMs: now, meta: initialMeta },
        deps.owner
      )
      if (put._tag === "FenceLost" || put._tag === "RunNotFound") {
        return yield* Effect.interrupt
      }
      if (put._tag !== "Inserted") {
        return yield* Effect.fail(
          new AttemptAdmissionRejected({
            code: "attempt_admission_rejected",
            keyDigest,
            outcome: put._tag
          })
        )
      }
      yield* journal.emit(JournalRecords.attemptStarted(source(deps), { ...attemptId, tier: input.tier }))

      let snapshotId: string | undefined
      if (input.tier === "compensable") {
        const jj = yield* Jj.Jj
        if (input.attempt > 1) {
          const previous = yield* attempts.get({ ...attemptId, attempt: input.attempt - 1 })
          if (
            Option.isSome(previous) &&
            decodeMeta(previous.value.meta)?.snapshotId !== undefined
          ) {
            yield* jj.restore(decodeMeta(previous.value.meta)!.snapshotId!)
          }
        }
        const snapshot = yield* jj.snapshot(`flows activity ${keyDigest} attempt ${input.attempt}`)
        snapshotId = snapshot.changeId
        yield* journal.emit(JournalRecords.snapshotIdentified(source(deps), { ...attemptId, snapshotId }))
      }

      const boundary = input.tier === "sealed" && input.metadata !== undefined
        ? yield* StepBoundary.StepBoundary
        : undefined
      const preparedResult = boundary === undefined || input.metadata === undefined
        ? undefined
        : yield* boundary.prepare(input.metadata).pipe(Effect.exit)
      if (preparedResult !== undefined && Exit.isFailure(preparedResult)) {
        const finishedAtMs = yield* Clock.currentTimeMillis
        const finished = yield* attempts.finish({
          ...attemptId,
          state: "failed",
          finishedAtMs,
          error: preparedResult.cause,
          meta: { tier: input.tier, ...(snapshotId === undefined ? {} : { snapshotId }) }
        }, deps.owner)
        if (finished._tag !== "Finished") return yield* Effect.interrupt
        yield* journal.emit(JournalRecords.hardViolation(source(deps), { ...attemptId, error: preparedResult.cause }))
        yield* journal.emit(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "failed" }))
        return yield* Effect.failCause(preparedResult.cause)
      }
      const prepared = preparedResult === undefined ? undefined : preparedResult.value

      const outcome = yield* deps.execute(input).pipe(Effect.exit)
      if (Exit.isFailure(outcome)) {
        const finishedAtMs = yield* Clock.currentTimeMillis
        const finished = yield* attempts.finish({
          ...attemptId,
          state: "failed",
          finishedAtMs,
          error: outcome.cause,
          meta: { tier: input.tier, ...(snapshotId === undefined ? {} : { snapshotId }) }
        }, deps.owner)
        if (finished._tag !== "Finished") return yield* Effect.interrupt
        yield* journal.emit(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "failed" }))
        return yield* Effect.failCause(outcome.cause)
      }

      const settled = prepared === undefined || boundary === undefined
        ? undefined
        : yield* boundary.settle(prepared).pipe(Effect.exit)
      if (settled !== undefined && Exit.isFailure(settled)) {
        const failedAtMs = yield* Clock.currentTimeMillis
        const finished = yield* attempts.finish({
          ...attemptId,
          state: "failed",
          finishedAtMs: failedAtMs,
          error: settled.cause,
          meta: { tier: input.tier, ...(snapshotId === undefined ? {} : { snapshotId }) }
        }, deps.owner)
        if (finished._tag !== "Finished") return yield* Effect.interrupt
        yield* journal.emit(JournalRecords.hardViolation(source(deps), { ...attemptId, error: settled.cause }))
        yield* journal.emit(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "failed" }))
        return yield* Effect.failCause(settled.cause)
      }
      const evidence = settled === undefined ? undefined : settled.value
      const finishedAtMs = yield* Clock.currentTimeMillis
      const meta: AttemptMeta = {
        tier: input.tier,
        ...(snapshotId === undefined ? {} : { snapshotId }),
        ...(evidence === undefined ? {} : { boundary: evidence })
      }
      const finished = yield* attempts.finish(
        { ...attemptId, state: "succeeded", finishedAtMs, outcome: outcome.value, meta },
        deps.owner
      )
      if (finished._tag !== "Finished") return yield* Effect.interrupt
      if (evidence?.deviation !== undefined) {
        yield* journal.emit(JournalRecords.expectedSetDeviation(source(deps), { ...attemptId, ...evidence.deviation }))
      }
      yield* journal.emit(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "succeeded" }))

      if (cacheable && evidence?.deviation === undefined) {
        const receipt = yield* journal.emit(
          JournalRecords.cacheProvenance(source(deps), { keyDigest, action: "recorded" })
        )
        yield* cache.put({
          keyDigest,
          result: outcome.value,
          meta,
          createdAtMs: finishedAtMs,
          recordedRunId: deps.runId,
          recordedEventSeq: receipt.seq
        })
      }
      return outcome.value
    })
  )
