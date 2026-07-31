/**
 * Journaled execution boundary for tiered effects.
 *
 * @since 0.1.0
 */
import * as Journal from "@smithers/journal/Journal"
import type * as JournalEvent from "@smithers/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { error, type TimeTravelError } from "./TimeTravelError.ts"

/**
 * The three effect tiers used by replay, compensation, and retry.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectTier = "sealed" | "compensable" | "irreversible"

/**
 * Monotonic completion evidence recorded around an effect.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectStatus = "intended" | "succeeded" | "unknown"

/**
 * Stable event type emitted for effect-boundary evidence.
 *
 * @since 0.1.0
 * @category constants
 */
export const eventType = "flows.time-travel.effect-boundary"

/**
 * A normalized effect reconstructed from boundary journal entries.
 *
 * @since 0.1.0
 * @category models
 */
export interface EffectRecord {
  readonly id: string
  readonly kind: string
  readonly tier: EffectTier
  readonly status: EffectStatus
  readonly runId: string
  readonly lineageId: string
  readonly seq: number
  readonly input?: unknown
  readonly output?: unknown
  readonly cacheKey?: string | undefined
  readonly changeId?: string | undefined
  readonly idempotencyKey?: string | undefined
  readonly residue?: string | undefined
  readonly durableBoundary: boolean
  readonly providerStream: boolean
  readonly attempt?: number | undefined
  readonly nonce?: string | undefined
}

/**
 * Description supplied before an activity crosses its effect boundary.
 *
 * @since 0.1.0
 * @category models
 */
export interface Description {
  readonly id: string
  readonly kind: string
  readonly tier: EffectTier
  readonly runId: string
  readonly lineageId: string
  readonly sourceId: string
  readonly sourceSeq?: number | undefined
  readonly input?: unknown
  readonly cacheKey?: string | undefined
  readonly changeId?: string | undefined
  readonly idempotencyKey?: string | undefined
  readonly residue?: string | undefined
  readonly durableBoundary?: boolean | undefined
  readonly providerStream?: boolean | undefined
  readonly attempt?: number | undefined
  readonly nonce?: string | undefined
  readonly metadata?: unknown
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const metadata = (
  description: Description,
  status: EffectStatus
): Readonly<Record<string, unknown>> => ({
  ...(isRecord(description.metadata) ? description.metadata : { upstream: description.metadata }),
  lineageId: description.lineageId,
  ...(description.cacheKey === undefined ? {} : { cacheKey: description.cacheKey }),
  timeTravel: {
    effectId: description.id,
    kind: description.kind,
    tier: description.tier,
    status
  }
})

const record = (
  description: Description,
  status: EffectStatus,
  output?: unknown
): Omit<EffectRecord, "seq"> => ({
  id: description.id,
  kind: description.kind,
  tier: description.tier,
  status,
  runId: description.runId,
  lineageId: description.lineageId,
  input: description.input,
  ...(output === undefined ? {} : { output }),
  cacheKey: description.cacheKey,
  changeId: description.changeId,
  idempotencyKey: description.idempotencyKey,
  residue: description.residue,
  durableBoundary: description.durableBoundary ?? true,
  providerStream: description.providerStream ?? false,
  attempt: description.attempt,
  nonce: description.nonce
})

const emit = (
  journal: Journal.Service,
  description: Description,
  status: EffectStatus,
  output?: unknown
): Effect.Effect<void, TimeTravelError> => {
  const sourceSeq = description.sourceSeq === undefined
    ? undefined
    : (description.sourceSeq + (status === "intended" ? 0 : 1)) as JournalEvent.SourceSeq
  const input: JournalEvent.Input = {
    runId: description.runId as JournalEvent.RunId,
    sourceId: description.sourceId as JournalEvent.SourceId,
    ...(sourceSeq === undefined ? {} : { sourceSeq }),
    eventType,
    payload: { effect: record(description, status, output) },
    meta: metadata(description, status)
  }
  return journal.emit(input).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      error("unknown", `could not record ${status} boundary for effect ${description.id}`, cause)
    )
  )
}

/**
 * Runs an activity between durable `intended` and terminal boundary records.
 *
 * Interruption, defects, and typed failures all settle the boundary as
 * `unknown` before their original cause is re-raised. The settlement section
 * is uninterruptible so cancellation cannot strand an in-memory activity
 * after it has crossed the boundary without attempting the terminal record.
 *
 * @since 0.1.0
 * @category combinators
 */
export const guard = <A, E, R>(
  description: Description,
  activity: Effect.Effect<A, E, R>
): Effect.Effect<A, E | TimeTravelError, R | Journal.Journal> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        yield* emit(journal, description, "intended")
        const activityExit = yield* Effect.exit(restore(activity))
        if (Exit.isSuccess(activityExit)) {
          yield* emit(journal, description, "succeeded", activityExit.value)
          return activityExit.value
        }
        yield* Effect.ignore(emit(journal, description, "unknown"))
        return yield* Effect.failCause(activityExit.cause)
      })
    )
  })

const isEffectTier = (value: unknown): value is EffectTier =>
  value === "sealed" || value === "compensable" || value === "irreversible"

const isEffectStatus = (value: unknown): value is EffectStatus =>
  value === "intended" || value === "succeeded" || value === "unknown"

/**
 * Decodes one boundary record from a journal entry.
 *
 * Unknown event types and malformed additive metadata are ignored so this
 * projection remains forward-compatible with unrelated journal records.
 *
 * @since 0.1.0
 * @category decoders
 */
export const fromEntry = (
  entry: JournalEvent.Entry
): EffectRecord | undefined => {
  if (entry.eventType !== eventType || !isRecord(entry.payload)) return undefined
  const effect = entry.payload.effect
  if (!isRecord(effect)) return undefined
  if (
    typeof effect.id !== "string" ||
    typeof effect.kind !== "string" ||
    !isEffectTier(effect.tier) ||
    !isEffectStatus(effect.status) ||
    typeof effect.runId !== "string" ||
    typeof effect.lineageId !== "string"
  ) {
    return undefined
  }
  return {
    id: effect.id,
    kind: effect.kind,
    tier: effect.tier,
    status: effect.status,
    runId: effect.runId,
    lineageId: effect.lineageId,
    seq: entry.seq,
    ...("input" in effect ? { input: effect.input } : {}),
    ...("output" in effect ? { output: effect.output } : {}),
    ...(typeof effect.cacheKey === "string" ? { cacheKey: effect.cacheKey } : {}),
    ...(typeof effect.changeId === "string" ? { changeId: effect.changeId } : {}),
    ...(typeof effect.idempotencyKey === "string" ? { idempotencyKey: effect.idempotencyKey } : {}),
    ...(typeof effect.residue === "string" ? { residue: effect.residue } : {}),
    durableBoundary: effect.durableBoundary !== false,
    providerStream: effect.providerStream === true,
    ...(typeof effect.attempt === "number" ? { attempt: effect.attempt } : {}),
    ...(typeof effect.nonce === "string" ? { nonce: effect.nonce } : {})
  }
}

/**
 * Folds boundary entries to the latest monotonic status for each effect while
 * retaining the sequence of the effect's last boundary record.
 *
 * @since 0.1.0
 * @category projections
 */
export const fromEntries = (
  entries: ReadonlyArray<JournalEvent.Entry>
): ReadonlyArray<EffectRecord> => {
  const effects = new Map<string, EffectRecord>()
  for (const entry of entries) {
    const decoded = fromEntry(entry)
    if (decoded !== undefined) effects.set(decoded.id, decoded)
  }
  return Array.from(effects.values()).sort((left, right) => left.seq - right.seq)
}
