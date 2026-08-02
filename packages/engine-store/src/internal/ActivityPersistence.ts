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
import * as AttemptAdmission from "./AttemptAdmission.ts"
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

/** @since 0.1.0 @category errors */
export class CacheCorruptionDetected extends Schema.TaggedErrorClass<CacheCorruptionDetected>()(
  "flows/engine-store/CacheCorruptionDetected",
  {
    code: Schema.Literal("cache_corruption_detected"),
    keyDigest: Schema.String,
    path: Schema.String,
    recordedDigest: Schema.String,
    measuredDigest: Schema.String
  }
) {}

/**
 * The one classification of a `replayOutputs` failure (issue #150): a
 * `BoundaryCorruption` in the cause is on-disk corruption of recorded
 * evidence — the store's strongest invariant violated — while anything else
 * is a transient host refusal that stays retryable. The two previously
 * journalled identically, so a failing disk corrupting many blobs was
 * indistinguishable from a one-off EIO.
 */
const replayCorruption = (
  cause: Cause.Cause<unknown>
): StepBoundary.BoundaryCorruption | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof StepBoundary.BoundaryCorruption) {
      return reason.error
    }
  }
  return undefined
}

/** @since 0.1.0 @category models */
export interface Dependencies {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly sourceId: string
  readonly execute: (input: ActivityInput) => Effect.Effect<unknown, unknown>
  readonly idempotencyKey?: string | undefined
  /**
   * The incarnation-wide admission mutex (issues #102, #103). `EngineStore`
   * passes one shared instance per store incarnation so every dispatch of a
   * given attempt key in this process serializes through it; when omitted, a
   * fresh mutex private to this `make` call is used — correct only when all
   * same-key dispatches share the returned executor.
   */
  readonly admission?: AttemptAdmission.Service | undefined
}

const AttemptMeta = Schema.Struct({
  tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
  boundary: Schema.optional(StepBoundary.BoundaryEvidence),
  /**
   * The prepare-time measurement matched the caller-declared read set the
   * step key was derived from (issue #106). Only such completions may enter
   * the shared cache: a stale declaration executes against the *real*
   * content, so recording its result under the declaration's key would hand
   * a later, genuinely accurate run the wrong value as a verified hit.
   */
  readSetVerified: Schema.optional(Schema.Literal(true)),
  /**
   * The failed row records a boundary violation (a prepare or settle
   * failure), so the failed replay branch can re-emit the `hardViolation`
   * journal record idempotently after a crash in the finish→emit window
   * (issue #109) — the violation kind is not recoverable from the persisted
   * cause alone.
   */
  hardViolation: Schema.optional(Schema.Literal(true)),
  snapshotId: Schema.optional(Schema.String),
  // The incarnation that admitted the running row. Since issues #102/#103
  // the adoption decision rests on the admission permit rather than this
  // nonce — a live same-key fiber of this process would be holding the
  // permit, which distinguishes a dead fiber from a live dispatch in a way
  // the recorded incarnation cannot — but the field is kept as durable
  // forensic evidence of which incarnation last drove the attempt.
  admittedBy: Schema.optional(Ownership.OwnerId)
})

type AttemptMeta = typeof AttemptMeta.Type

const decodeMeta = (value: unknown): AttemptMeta | undefined => {
  const decoded = Schema.decodeUnknownResult(AttemptMeta)(value)
  return decoded._tag === "Success" ? decoded.success : undefined
}

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
export const make = (deps: Dependencies) => {
  const admission = deps.admission ?? AttemptAdmission.makeUnsafe()
  return Effect.fn("ActivityPersistence.execute")((input: ActivityInput) =>
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
       * Cache-provenance producer identity (issue #124): the plain
       * `{runId, sourceId}` identity carried no `sourceSeq`, so every re-drive of
       * the same observation — the same replay refusal against the same
       * recorded row, on every later dispatch of the key — appended a fresh
       * journal row forever. A per-(key, action, recorded-provenance)
       * identity with `sourceSeq 0` collapses the identical re-observation
       * into a `Duplicate`, while folding the recorded row's provenance into
       * the identity keeps a genuinely new observation — the same action
       * against a *different* recorded row — a distinct producer that still
       * journals.
       */
      const cacheSource = (
        action: string,
        recorded?: { readonly runId: string; readonly eventSeq: number }
      ): JournalRecords.EventOptions => ({
        runId: deps.runId,
        sourceId: `${deps.sourceId}:cache:${keyDigest}:${action}${
          recorded === undefined ? "" : `:${recorded.runId}:${recorded.eventSeq}`
        }`,
        sourceSeq: 0
      })
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
          // The producer identity folds a digest of the recorded content
          // (issue #129): a constant per-key identity made a post-eviction
          // re-record collapse into a `Duplicate` carrying the EVICTED
          // generation's seq, so the fresh row inherited the evicted row's
          // exact provenance and a laggard's #119 `ifRecordedBy` fence could
          // delete the valid new row. With the content folded in, the #124
          // convergence re-record (identical content, rebuilt from the same
          // persisted attempt row, so the serialization is byte-stable)
          // still collapses into a `Duplicate` whose receipt carries the
          // original emission's canonical seq, while a re-record with
          // different content is a distinct producer that journals fresh
          // provenance. A re-record whose content happens to equal the
          // evicted generation's shares its provenance by design: the two
          // rows are indistinguishable, so a fenced evict of one is exactly
          // a fenced evict of the other.
          const generation = Digest.digest(
            JSON.stringify({ meta: options.meta, result: options.result })
          )
          const receipt = yield* emitLifecycle(
            JournalRecords.cacheProvenance({
              runId: deps.runId,
              sourceId: `${deps.sourceId}:cache:${keyDigest}:recorded:${generation}`,
              sourceSeq: 0
            }, { keyDigest, action: "recorded" })
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
      // Everything from the cache-hit verification to the terminal transition
      // runs under this process's exclusive permit for the attempt key
      // (issues #102, #103, #118): the adoption decision below is taken from
      // a read no in-process racer can invalidate before the claim lands, a
      // concurrent same-key dispatch waits here until the winner's terminal
      // row is visible and replays it instead of re-executing the body, and
      // the cache block's read-verify-materialize-evict span can never
      // interleave with another dispatch's execution. A verified hit returns
      // from inside the permit. The permit is keyed by (runId, keyDigest)
      // alone (issue #133): the cache row is addressed by keyDigest with no
      // attempt material, so folding the attempt counter in let sanctioned
      // keyed dispatches at skewed attempt counters (#111/#116) acquire
      // different permits and interleave the very span the permit serializes.
      return yield* admission.withPermit(`${deps.runId}|${keyDigest}`)(
        Effect.gen(function*() {
          // Lifecycle announcements take a per-attempt producer identity
          // (issue #91): adoption — or a replay after a crash in the
          // finish→emit window (issue #109) — re-emits records a dead
          // incarnation may already have announced, and lifecycle records
          // without a `sourceSeq` allocate a fresh journal row on every
          // emission. A dedicated `(sourceId, sourceSeq 0)` per record makes
          // the re-emission an exact producer retry the journal collapses
          // into a `Duplicate`.
          const attemptSource = (record: string): JournalRecords.EventOptions => ({
            runId: deps.runId,
            sourceId: `${deps.sourceId}:attempt:${keyDigest}:${input.attempt}:${record}`,
            sourceSeq: 0
          })
          /**
           * Journal-convergence emit for the replay branches (issue #109):
           * an identical re-emission collapses into a `Duplicate`, and an
           * `idempotency_conflict` means the journal already holds a
           * terminal record under this producer identity whose payload was
           * recorded by another lineage — a time-travel fork copies the
           * parent's journal rows, so the copied record names the parent
           * run. Either way the terminal event exists; only its absence is
           * the defect being repaired.
           */
          const emitConverging = (record: JournalEvent.Input) =>
            emitLifecycle(record).pipe(
              Effect.catch((error) =>
                error.code === "idempotency_conflict" ? Effect.succeed(undefined) : Effect.fail(error)
              )
            )
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
                  const materialized = yield* boundary.replayOutputs(meta.boundary).pipe(Effect.exit)
                  if (Exit.isSuccess(materialized)) {
                    const recorded = {
                      runId: cached.value.recordedRunId,
                      eventSeq: cached.value.recordedEventSeq
                    }
                    yield* emitConverging(JournalRecords.cacheProvenance(cacheSource("hit", recorded), {
                      keyDigest,
                      recordedRunId: cached.value.recordedRunId,
                      recordedEventSeq: cached.value.recordedEventSeq
                    }))
                    return cached.value.result
                  }
                  // Evidence the host cannot re-materialize — a transient
                  // filesystem error, or a row recorded by a foreign boundary
                  // implementation — is not a hit and not a run failure
                  // (issue #107): failing here while the verified row survived
                  // repeated refuse→fail on every later run, the exact
                  // permanent-failure loop #99 closed one branch later. The
                  // refusal is journalled and the dispatch path below executes
                  // for real; the row survives for hosts that can replay it.
                  // The refusal record carries its classification (issue
                  // #150): `corruption` for a digest mismatch at the
                  // content-addressed blob path, `host` for everything else —
                  // a failing disk corrupting many blobs must never journal
                  // identically to a one-off EIO.
                  const corruption = replayCorruption(materialized.cause)
                  yield* emitConverging(
                    JournalRecords.cacheProvenance(
                      cacheSource("replay_failed", {
                        runId: cached.value.recordedRunId,
                        eventSeq: cached.value.recordedEventSeq
                      }),
                      {
                        keyDigest,
                        action: "replay_failed",
                        reason: corruption === undefined ? "host" : "corruption",
                        recordedRunId: cached.value.recordedRunId,
                        recordedEventSeq: cached.value.recordedEventSeq
                      }
                    )
                  )
                  if (corruption !== undefined) {
                    // Corruption is an integrity violation, not a retryable
                    // refusal: it routes to the Inconsistency receiver like
                    // a cache-key conflict does. The core default is STRICT
                    // (fail); `Inconsistency.layerTolerant` (or a plugin
                    // verdict) lets the dispatch fall back to the real
                    // execution below, whose re-capture heals the address.
                    const receiverOption = yield* Effect.serviceOption(Inconsistency.Inconsistency)
                    const receiver = Option.isSome(receiverOption)
                      ? receiverOption.value
                      : Inconsistency.make({ journal, verdict: "fail", owner: deps.owner })
                    const verdict = yield* receiver.noteCorruption({
                      runId: deps.runId,
                      keyDigest,
                      path: corruption.path,
                      recordedDigest: corruption.recordedDigest,
                      measuredDigest: corruption.measuredDigest,
                      recordedRunId: cached.value.recordedRunId,
                      recordedEventSeq: cached.value.recordedEventSeq
                    })
                    // Quarantine is journal AND evict (issue #164). The
                    // receiver's durable record preserved the evidence, but
                    // leaving the row in place made the poison permanent for
                    // INLINE evidence: `CacheStore.put` is insert-or-nothing,
                    // so a tolerant re-execution never replaced the corrupt
                    // bytes and re-detected them on every later run, while
                    // strict mode re-failed the key forever. Evicting under
                    // both verdicts lets the next dispatch — the tolerant
                    // fall-through below, or the run after a strict failure —
                    // execute and record cleanly. The evict is fenced on the
                    // poisoned row's own provenance like the stale-read-set
                    // branch (issue #119): a fresh row landed by a concurrent
                    // run between this dispatch's `get` and the `evict` makes
                    // the compare-and-swap a no-op instead of deleting valid
                    // evidence.
                    yield* cache.evict(keyDigest, {
                      ifRecordedBy: {
                        runId: cached.value.recordedRunId,
                        eventSeq: cached.value.recordedEventSeq
                      }
                    })
                    if (verdict === "fail") {
                      return yield* Effect.fail(
                        new CacheCorruptionDetected({
                          code: "cache_corruption_detected",
                          keyDigest,
                          path: corruption.path,
                          recordedDigest: corruption.recordedDigest,
                          measuredDigest: corruption.measuredDigest
                        })
                      )
                    }
                  }
                } else if (Option.isSome(measured)) {
                  // Only a *measured* mismatch is evidence the inputs changed
                  // (issue #110): a host that cannot measure right now — a
                  // transient EIO/EACCES on any declared read path — says
                  // nothing about the read set, so the hit is merely refused for
                  // this dispatch (the path below re-prepares and surfaces the
                  // host failure as an ordinary attempt failure) and the valid
                  // shared row survives for every run whose host is healthy.
                  //
                  // The durable emit is also the fence: `emitDurable` fails with
                  // `fence_lost` for a zombie that lost the run, surfacing as
                  // self-interruption before the eviction below can run.
                  yield* emitConverging(
                    JournalRecords.cacheProvenance(
                      cacheSource("stale_read_set", {
                        runId: cached.value.recordedRunId,
                        eventSeq: cached.value.recordedEventSeq
                      }),
                      {
                        keyDigest,
                        action: "stale_read_set",
                        recordedRunId: cached.value.recordedRunId,
                        recordedEventSeq: cached.value.recordedEventSeq
                      }
                    )
                  )
                  // Skyframe invalidation, not just refusal (issue #99): a stale
                  // read set means the inputs changed, so the re-execution's
                  // result is *expected* to differ — left in place, the poisoned
                  // row turns the fresh `cache.put` into a Conflict, the strict
                  // verdict fails the run, and nothing ever removes the row, so
                  // every later run repeats the refuse → re-execute → conflict →
                  // fail cycle. The refusal is journalled above; evicting here
                  // lets the re-execution record cleanly under the same key.
                  // The eviction is fenced on the poisoned row's own
                  // provenance (issue #119): a fresh entry recorded by a
                  // concurrent run between this dispatch's `get` and its
                  // `evict` must not be deleted with the poison (issue #110).
                  // The permit (issue #118) only closes the *in-process*
                  // window, so the guard rides inside the DELETE rather than
                  // in a preceding read — a foreign process landing a fresh
                  // row simply makes the compare-and-swap a no-op.
                  yield* cache.evict(keyDigest, {
                    ifRecordedBy: {
                      runId: cached.value.recordedRunId,
                      eventSeq: cached.value.recordedEventSeq
                    }
                  })
                }
              }
            }
          }

          const existing = yield* attempts.get(attemptId)
          if (Option.isSome(existing)) {
            const row = existing.value
            if (row.state === "succeeded") {
              const meta = decodeMeta(row.meta)
              let corruptEvidence = false
              if (meta?.boundary !== undefined) {
                const boundary = yield* StepBoundary.StepBoundary
                const materialized = yield* boundary.replayOutputs(meta.boundary).pipe(Effect.exit)
                if (Exit.isFailure(materialized)) {
                  // The attempt durably succeeded: its recorded outcome is
                  // the truth, and re-materializing the workspace outputs is
                  // best-effort — failing the dispatch here while the
                  // terminal row survived recreated the #99 permanent
                  // refuse→fail loop one branch earlier (issue #107). The
                  // refusal is journalled so a missing output is
                  // explainable rather than silent, and it carries its
                  // classification (issue #150): corruption of the recorded
                  // evidence routes to the Inconsistency receiver instead of
                  // passing as an ordinary transient host refusal.
                  const corruption = replayCorruption(materialized.cause)
                  corruptEvidence = corruption !== undefined
                  yield* emitConverging(
                    JournalRecords.cacheProvenance(cacheSource("replay_failed"), {
                      keyDigest,
                      action: "replay_failed",
                      reason: corruption === undefined ? "host" : "corruption"
                    })
                  )
                  if (corruption !== undefined) {
                    const receiverOption = yield* Effect.serviceOption(Inconsistency.Inconsistency)
                    const receiver = Option.isSome(receiverOption)
                      ? receiverOption.value
                      : Inconsistency.make({ journal, verdict: "fail", owner: deps.owner })
                    const verdict = yield* receiver.noteCorruption({
                      runId: deps.runId,
                      keyDigest,
                      path: corruption.path,
                      recordedDigest: corruption.recordedDigest,
                      measuredDigest: corruption.measuredDigest
                    })
                    if (verdict === "fail") {
                      return yield* Effect.fail(
                        new CacheCorruptionDetected({
                          code: "cache_corruption_detected",
                          keyDigest,
                          path: corruption.path,
                          recordedDigest: corruption.recordedDigest,
                          measuredDigest: corruption.measuredDigest
                        })
                      )
                    }
                  }
                }
              }
              // Converge the cache with the durable completion: a crash between
              // `attempts.finish` and `cache.put` otherwise leaves the sealed
              // result permanently missing from the shared cache (issue #24).
              // Reaching this branch with `cacheable` set means `cache.get`
              // above missed or was unfit for replay.
              // Only a row whose recorded read set was verified at prepare
              // time may converge into the shared cache (issue #106): an
              // unverified result was computed against content the key does
              // not describe.
              // A row whose boundary evidence was just measured corrupt is
              // quarantined, never converged (issue #160): a `tolerate`
              // verdict keeps the durable outcome as this run's truth, but
              // publishing the known-corrupt evidence into the shared cache
              // would hand sibling runs a poisoned hit under this run's
              // provenance.
              if (
                !corruptEvidence &&
                cacheable &&
                meta?.tier === "sealed" &&
                meta.boundary !== undefined &&
                meta.boundary.deviation === undefined &&
                meta.readSetVerified === true
              ) {
                yield* recordCache({
                  result: row.outcome,
                  meta,
                  createdAtMs: row.finishedAtMs ?? (yield* Clock.currentTimeMillis)
                })
              }
              // Converge the journal with the durable completion (issue
              // #109): a crash between `attempts.finish` and the terminal
              // emits left `attemptStarted` without `attemptFinished`
              // forever. The per-attempt producer identity collapses the
              // re-emission into a `Duplicate` on ordinary replays.
              if (meta?.boundary?.deviation !== undefined) {
                yield* emitConverging(
                  JournalRecords.expectedSetDeviation(attemptSource("deviation"), {
                    ...attemptId,
                    ...meta.boundary.deviation
                  })
                )
              }
              yield* emitConverging(
                JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "succeeded" })
              )
              return row.outcome
            }
            if (row.state === "failed") {
              // Converge the journal before rethrowing (issue #109): the
              // violation kind survives in the row meta because the
              // persisted cause alone cannot distinguish a boundary
              // violation from an ordinary execution failure.
              if (decodeMeta(row.meta)?.hardViolation === true) {
                yield* emitConverging(
                  JournalRecords.hardViolation(attemptSource("hard-violation"), {
                    ...attemptId,
                    error: rehydrateCause(row.error)
                  })
                )
              }
              yield* emitConverging(
                JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
              )
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
           * Adoption requires liveness evidence (issue #86), and that evidence is
           * the admission permit held around this whole span (issues #102, #103):
           * a live same-key dispatch of this process would be holding the permit,
           * so a `running` row observed here cannot belong to a live in-process
           * fiber — it is a dead fiber of this incarnation (an in-process
           * re-drive after an interrupt, the #71 mode the recorded-nonce guard
           * wrongly refused) or a superseded incarnation (which provably lost the
           * run fence this owner holds). Deciding from the recorded `admittedBy`
           * nonce could not tell those apart, and comparing it against a stale
           * pre-claim read left a TOCTOU window where two concurrent dispatches
           * both saw a dead owner and both executed an irreversible body.
           */
          const runningRow = Option.isSome(existing) && existing.value.state === "running"
            ? existing.value
            : undefined
          const runningMeta = runningRow === undefined ? undefined : decodeMeta(runningRow.meta)
          const adopted = runningRow !== undefined
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
            // The claim is fenced at the moment it lands (issue #102): re-verify
            // run ownership immediately before re-homing the row, so a process
            // that lost the fence while waiting on the permit parks instead of
            // patching a run it no longer owns. With the permit excluding
            // in-process racers and the fence excluding every other process's
            // writers (`put`/`finish` are owner-fenced), the patch below is
            // exclusive even though `AttemptStore` has no conditional update.
            const claimAtMs = yield* Clock.currentTimeMillis
            const claimFence = yield* runs.heartbeat(deps.runId, deps.owner, claimAtMs)
            if (claimFence._tag !== "Updated") return yield* Effect.interrupt
            // Re-home the adopted row to the current incarnation; the patch
            // keeps the dead incarnation's other meta (tier, pre-image
            // snapshot) intact. A vanished row means the durable state moved
            // under us — surface it as self-interruption like the fence losses.
            const rehomed = yield* attempts.patch(attemptId, {
              meta: { ...runningMeta, tier: input.tier, admittedBy: deps.owner } satisfies AttemptMeta
            })
            if (rehomed._tag !== "Patched") return yield* Effect.interrupt
          }
          yield* emitLifecycle(
            JournalRecords.attemptStarted(attemptSource("started"), { ...attemptId, tier: input.tier })
          )

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
            yield* emitLifecycle(
              JournalRecords.snapshotIdentified(attemptSource("snapshot"), { ...attemptId, snapshotId })
            )
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
              meta: { tier: input.tier, hardViolation: true }
            }, deps.owner)
            if (finished._tag !== "Finished") return yield* Effect.interrupt
            yield* emitLifecycle(
              JournalRecords.hardViolation(attemptSource("hard-violation"), {
                ...attemptId,
                error: preparedResult.cause
              })
            )
            yield* emitLifecycle(
              JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
            )
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
            yield* emitLifecycle(
              JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
            )
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
              meta: { tier: input.tier, hardViolation: true }
            }, deps.owner)
            if (finished._tag !== "Finished") return yield* Effect.interrupt
            yield* emitLifecycle(
              JournalRecords.hardViolation(attemptSource("hard-violation"), { ...attemptId, error: settled.cause })
            )
            yield* emitLifecycle(
              JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "failed" })
            )
            return yield* Effect.failCause(settled.cause)
          }
          const evidence = settled === undefined ? undefined : settled.value
          const finishedAtMs = yield* Clock.currentTimeMillis
          // The declared read set is the key material; the prepare-time
          // measurement is the evidence it described reality when the body
          // ran (issue #106). A mismatch means the result was computed from
          // different inputs than the key claims — the attempt itself is
          // fine, but the completion must never enter the shared cache.
          const readSetVerified = prepared !== undefined && StepBoundary.readSetMatches(prepared)
          const meta: AttemptMeta = {
            tier: input.tier,
            ...(snapshotId === undefined ? {} : { snapshotId }),
            ...(evidence === undefined ? {} : { boundary: evidence }),
            ...(readSetVerified ? { readSetVerified: true as const } : {})
          }
          const finished = yield* attempts.finish(
            { ...attemptId, state: "succeeded", finishedAtMs, outcome: outcome.value, meta },
            deps.owner
          )
          if (finished._tag !== "Finished") return yield* Effect.interrupt
          if (evidence?.deviation !== undefined) {
            yield* emitLifecycle(
              JournalRecords.expectedSetDeviation(attemptSource("deviation"), { ...attemptId, ...evidence.deviation })
            )
          }
          yield* emitLifecycle(
            JournalRecords.attemptFinished(attemptSource("finished"), { ...attemptId, state: "succeeded" })
          )

          if (cacheable && evidence?.deviation === undefined) {
            if (readSetVerified) {
              yield* recordCache({ result: outcome.value, meta, createdAtMs: finishedAtMs })
            } else {
              // Visible, not silent (issue #106): the run continues on its
              // own result, but the stale declaration is journalled so the
              // missing cache entry is explainable.
              yield* emitConverging(
                JournalRecords.cacheProvenance(cacheSource("unverified_read_set"), {
                  keyDigest,
                  action: "unverified_read_set"
                })
              )
            }
          }
          return outcome.value
        })
      )
    })
  )
}
