/**
 * Durable activity dispatch at the engine encoded seam.
 *
 * Governing designs: `docs/specs/Concepts/Run Ownership.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { AttemptStore, CacheStore, Journal, type JournalEvent, Ownership, RunStore } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Inconsistency from "../Inconsistency.ts"
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

/** @since 0.1.0 @category errors */
export class CacheConflictDetected extends Schema.TaggedErrorClass<CacheConflictDetected>()(
  "flows/engine-store/CacheConflictDetected",
  {
    code: Schema.Literal("cache_conflict_detected"),
    keyDigest: Schema.String,
    recordedRunId: Schema.String
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
  snapshotId: Schema.optional(Schema.String),
  // The incarnation that admitted the running row (issue #86): adoption may
  // only claim a row whose admitting incarnation is provably superseded —
  // this owner holds the run fence, so any *other* recorded incarnation has
  // lost it. A row admitted by the current incarnation is a live concurrent
  // dispatch, not crash evidence.
  admittedBy: Schema.optional(Ownership.OwnerId)
})

type AttemptMeta = typeof AttemptMeta.Type

const decodeMeta = (value: unknown): AttemptMeta | undefined => {
  const decoded = Schema.decodeUnknownResult(AttemptMeta)(value)
  return decoded._tag === "Success" ? decoded.success : undefined
}

const source = (deps: Dependencies) => ({ runId: deps.runId, sourceId: deps.sourceId })

const CauseJson = Schema.Struct({
  reasons: Schema.Array(Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Fail"), error: Schema.Unknown }),
    Schema.Struct({ _tag: Schema.Literal("Die"), defect: Schema.Unknown }),
    Schema.Struct({
      _tag: Schema.Literal("Interrupt"),
      fiberId: Schema.optional(Schema.NullOr(Schema.Number))
    })
  ]))
})

/**
 * Encodes a live `Cause` into the plain tagged-reason JSON `rehydrateCause`
 * decodes. Persisting the `Cause` object itself left the durable shape to
 * whatever the ambient serializer produced (`Cause.toJSON` emits
 * `{_id, failures}`, a structural walk emits `{reasons}`), so a change in
 * the store's encoding silently broke failed-attempt replay. The write side
 * now owns the shape explicitly.
 */
const persistCause = (cause: Cause.Cause<unknown>): typeof CauseJson.Type => ({
  reasons: cause.reasons.map((reason) =>
    Cause.isFailReason(reason)
      ? { _tag: "Fail" as const, error: reason.error }
      : Cause.isDieReason(reason)
      ? { _tag: "Die" as const, defect: reason.defect }
      : { _tag: "Interrupt" as const, fiberId: reason.fiberId ?? null }
  )
})

/**
 * Rebuilds the persisted failure of a `failed` attempt row so replay can
 * rethrow the original domain error (issue #59). The row's `error` column
 * holds the {@link persistCause} encoding of the failing `Cause` — a plain
 * object whose `reasons` carry the tagged `Fail`/`Die`/`Interrupt` material.
 * `Fail` errors are already schema-encoded by `Activity.executeEncoded`, so
 * their `_tag` survives and `RetryPolicy` non-retryable matching applies on
 * replay exactly as it did on the live attempt. Live reasons are rebuilt
 * unconditionally from the tagged material; anything unrecognizable becomes
 * a defect carrying the raw persisted value.
 */
const rehydrateCause = (error: unknown): Cause.Cause<unknown> => {
  const decoded = Schema.decodeUnknownResult(CauseJson)(error)
  if (decoded._tag === "Success" && decoded.success.reasons.length > 0) {
    return Cause.fromReasons(decoded.success.reasons.map((reason) => {
      switch (reason._tag) {
        case "Fail":
          return Cause.makeFailReason(reason.error)
        case "Die":
          return Cause.makeDieReason(reason.defect)
        case "Interrupt":
          return Cause.makeInterruptReason(reason.fiberId ?? undefined)
      }
    }))
  }
  return Cause.die(error)
}

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
      /**
       * Lifecycle events take the journal's durable channel, fenced to the
       * owning process: the write commits inside the SQL sink while
       * `flows_runs` still records `deps.owner`, so a reclaimed (zombie) run
       * fails with `fence_lost` — surfaced as self-interruption, matching the
       * store-level fence outcomes — and a saturated lossy queue can never
       * drop an attempt lifecycle record (issue #10).
       */
      const emitLifecycle = (record: JournalEvent.Input) =>
        journal.emitDurable(record, deps.owner).pipe(
          Effect.catch((error) => error.code === "fence_lost" ? Effect.interrupt : Effect.fail(error))
        )
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

      /**
       * Records the sealed completion into the shared cache with provenance,
       * failing (by default) on a divergent first-recorded row. Used by both
       * the fresh completion path and succeeded-attempt replay, so a crash
       * between `attempts.finish` and `cache.put` converges on restart
       * instead of leaving the cache permanently behind the journal.
       */
      const recordCache = (options: {
        readonly result: unknown
        readonly meta: AttemptMeta
        readonly createdAtMs: number
      }) =>
        Effect.gen(function*() {
          const receipt = yield* emitLifecycle(
            JournalRecords.cacheProvenance(source(deps), { keyDigest, action: "recorded" })
          )
          const entry = {
            keyDigest,
            result: options.result,
            meta: options.meta,
            createdAtMs: options.createdAtMs,
            recordedRunId: deps.runId,
            recordedEventSeq: receipt.seq
          }
          const cachePut = yield* cache.put(entry)
          if (cachePut._tag === "Conflict") {
            const conflicting = yield* cache.get(keyDigest)
            const receiverOption = yield* Effect.serviceOption(Inconsistency.Inconsistency)
            // Core default is STRICT: journal the conflict and fail the run
            // (`docs/architecture/plugin-system.md`, the `cacheInconsistency`
            // hook's core default). Providing `Inconsistency.layerTolerant`
            // opts out.
            const receiver = Option.isSome(receiverOption)
              ? receiverOption.value
              : Inconsistency.make({ journal, verdict: "fail", owner: deps.owner })
            const verdict = yield* receiver.note({
              key: keyDigest,
              existing: Option.getOrUndefined(conflicting),
              attempted: entry
            })
            if (verdict === "fail") {
              return yield* Effect.fail(
                new CacheConflictDetected({
                  code: "cache_conflict_detected",
                  keyDigest,
                  recordedRunId: Option.isSome(conflicting) ? conflicting.value.recordedRunId : "unknown"
                })
              )
            }
          }
        })
      if (cacheable && input.metadata !== undefined) {
        const cached = yield* cache.get(keyDigest)
        if (Option.isSome(cached)) {
          const meta = decodeMeta(cached.value.meta)
          if (meta?.tier === "sealed" && meta.boundary !== undefined && meta.boundary.deviation === undefined) {
            const boundary = yield* StepBoundary.StepBoundary
            // Skyframe's dirty check, not "the declaration changed" (issue
            // #90): the read-set digests folded into the step key are caller
            // metadata, so reuse is justified only once the host has
            // measured them and agreed. A stale declaration falls through to
            // a real execution instead of replaying a pre-edit result, and
            // the refusal is journalled so it is visible rather than silent.
            // A boundary the host cannot enforce is likewise not a hit; the
            // dispatch path below re-prepares and fails the attempt properly.
            const measured = yield* boundary.prepare(input.metadata).pipe(Effect.option)
            const verified = Option.isSome(measured) && StepBoundary.readSetMatches(measured.value)
            if (verified) {
              yield* boundary.replayOutputs(meta.boundary)
              yield* emitLifecycle(JournalRecords.cacheProvenance(source(deps), {
                keyDigest,
                recordedRunId: cached.value.recordedRunId,
                recordedEventSeq: cached.value.recordedEventSeq
              }))
              return cached.value.result
            }
            yield* emitLifecycle(JournalRecords.cacheProvenance(source(deps), {
              keyDigest,
              action: "stale_read_set",
              recordedRunId: cached.value.recordedRunId,
              recordedEventSeq: cached.value.recordedEventSeq
            }))
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
          // Converge the cache with the durable completion: a crash between
          // `attempts.finish` and `cache.put` otherwise leaves the sealed
          // result permanently missing from the shared cache (issue #24).
          // Reaching this branch with `cacheable` set means `cache.get`
          // above missed or was unfit for replay.
          if (
            cacheable &&
            meta?.tier === "sealed" &&
            meta.boundary !== undefined &&
            meta.boundary.deviation === undefined
          ) {
            yield* recordCache({
              result: row.outcome,
              meta,
              createdAtMs: row.finishedAtMs ?? (yield* Clock.currentTimeMillis)
            })
          }
          return row.outcome
        }
        if (row.state === "failed") {
          // A durably failed attempt is replayed by rethrowing the persisted
          // domain failure — never by readmission (issue #59). Falling
          // through to `attempts.put` here surfaced the row as
          // `AttemptAdmissionRejected`, whose tag can never match a
          // policy-declared `nonRetryable` classification, so a durably
          // failed no-retry activity earned an extra real dispatch after
          // resume. Temporal's prior art: mutable state persists the attempt
          // failure and `ExecutionInfo.Attempt`, and its no-retry decision
          // (`service/history/workflow/retry.go`) is re-evaluated from that
          // persisted failure — the failure itself is durable, not just the
          // fact that an attempt happened.
          return yield* Effect.failCause(rehydrateCause(row.error))
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

      /**
       * A persisted `running` row read while this owner holds the run fence
       * is crash evidence, not a live admission (issue #71): the incarnation
       * that admitted the attempt died before finishing (SIGKILL, OOM), and
       * the #53 stale-running sweep re-drove the run to a new owner — or the
       * same owner after restart. The attempt never completed, so it must
       * re-execute under its original number rather than fall through to
       * `attempts.put` (whose `Conflict` on the differing `startedAtMs`
       * surfaced as `AttemptAdmissionRejected`, permanently failing a
       * no-policy run with an infrastructure tag). The row is adopted; the
       * ordinary fenced `attempts.finish` transition below records the
       * re-execution's outcome.
       *
       * Adoption requires liveness evidence (issue #86): the row's recorded
       * `admittedBy` incarnation must differ from the current one. This owner
       * holds the run fence (heartbeat above), so a differing incarnation has
       * provably lost it; a row admitted by the *current* incarnation is a
       * live concurrent same-key dispatch and falls through to `attempts.put`,
       * whose `Conflict` surfaces as `AttemptAdmissionRejected` instead of
       * silently double-executing the side effect. A row without `admittedBy`
       * predates this evidence and keeps the #71 crash-evidence reading.
       */
      const runningRow = Option.isSome(existing) && existing.value.state === "running"
        ? existing.value
        : undefined
      const runningMeta = runningRow === undefined ? undefined : decodeMeta(runningRow.meta)
      const sameIncarnation = (candidate: Ownership.OwnerId): boolean =>
        candidate.hostId === deps.owner.hostId &&
        candidate.pid === deps.owner.pid &&
        candidate.nonce === deps.owner.nonce
      const adopted = runningRow !== undefined &&
        (runningMeta?.admittedBy === undefined || !sameIncarnation(runningMeta.admittedBy))
      if (!adopted) {
        const now = yield* Clock.currentTimeMillis
        const initialMeta: AttemptMeta = { tier: input.tier, admittedBy: deps.owner }
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
      } else {
        // Re-home the adopted row to the current incarnation so a concurrent
        // dispatch in *this* process reads it as live, not as crash evidence.
        // The unfenced patch keeps the dead incarnation's other meta (tier,
        // pre-image snapshot) intact.
        yield* attempts.patch(attemptId, {
          meta: { ...runningMeta, tier: input.tier, admittedBy: deps.owner } satisfies AttemptMeta
        })
      }
      // Lifecycle announcements take a per-attempt producer identity
      // (issue #91): adoption re-executes an attempt whose dead incarnation
      // may already have announced it, and lifecycle records without a
      // `sourceSeq` allocate a fresh journal row on every emission. A
      // dedicated `(sourceId, sourceSeq 0)` per record makes the re-emission
      // an exact producer retry the journal collapses into a `Duplicate`.
      const attemptSource = (record: string): JournalRecords.EventOptions => ({
        runId: deps.runId,
        sourceId: `${deps.sourceId}:attempt:${keyDigest}:${input.attempt}:${record}`,
        sourceSeq: 0
      })
      yield* emitLifecycle(JournalRecords.attemptStarted(attemptSource("started"), { ...attemptId, tier: input.tier }))

      let snapshotId: string | undefined
      if (input.tier === "compensable") {
        const jj = yield* Jj.Jj
        if (adopted && runningMeta?.snapshotId !== undefined) {
          // The dead incarnation persisted this attempt's own pre-image
          // before mutating the workspace (issue #87): restore it so the
          // re-execution runs on the clean tree, and keep it as the attempt's
          // compensation baseline instead of snapshotting the dirty state.
          yield* jj.restore(runningMeta.snapshotId)
          snapshotId = runningMeta.snapshotId
        } else {
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
          // Persist the pre-image into the running row before announcing it
          // (issue #87): a SIGKILL mid-attempt must not lose the only
          // reference to the clean tree, or adoption re-executes on top of
          // the dead incarnation's partial mutations.
          yield* attempts.patch(attemptId, {
            meta: { tier: input.tier, admittedBy: deps.owner, snapshotId } satisfies AttemptMeta
          })
        }
        yield* emitLifecycle(JournalRecords.snapshotIdentified(attemptSource("snapshot"), { ...attemptId, snapshotId }))
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
          error: persistCause(preparedResult.cause),
          // A boundary is prepared only for sealed work, while snapshots are
          // created only for compensable work. The two capabilities are
          // disjoint, so a preparation failure can never carry a snapshot.
          meta: { tier: input.tier }
        }, deps.owner)
        if (finished._tag !== "Finished") return yield* Effect.interrupt
        yield* emitLifecycle(JournalRecords.hardViolation(source(deps), { ...attemptId, error: preparedResult.cause }))
        yield* emitLifecycle(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "failed" }))
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
          error: persistCause(outcome.cause),
          meta: { tier: input.tier, ...(snapshotId === undefined ? {} : { snapshotId }) }
        }, deps.owner)
        if (finished._tag !== "Finished") return yield* Effect.interrupt
        yield* emitLifecycle(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "failed" }))
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
          error: persistCause(settled.cause),
          // Settlement, like preparation, runs only for sealed work; a
          // compensable snapshot is therefore unreachable on this path.
          meta: { tier: input.tier }
        }, deps.owner)
        if (finished._tag !== "Finished") return yield* Effect.interrupt
        yield* emitLifecycle(JournalRecords.hardViolation(source(deps), { ...attemptId, error: settled.cause }))
        yield* emitLifecycle(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "failed" }))
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
        yield* emitLifecycle(JournalRecords.expectedSetDeviation(source(deps), { ...attemptId, ...evidence.deviation }))
      }
      yield* emitLifecycle(JournalRecords.attemptFinished(source(deps), { ...attemptId, state: "succeeded" }))

      if (cacheable && evidence?.deviation === undefined) {
        yield* recordCache({ result: outcome.value, meta, createdAtMs: finishedAtMs })
      }
      return outcome.value
    })
  )
