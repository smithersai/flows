/**
 * Receiver for detected engine inconsistencies.
 *
 * Modeled on Skyframe's `GraphInconsistencyReceiver`: the store layer detects
 * an invariant violation — today, a content-addressed cache key that produced
 * a different result than the recorded row — and this service decides whether
 * the run fails or tolerates it. Either way the conflict is journaled, so the
 * detector is never wired to /dev/null.
 *
 * The `note` signature deliberately matches the plugin spec's
 * `cacheInconsistency` hook (`(event) => Effect<InconsistencyVerdict>`); the
 * strict layer is the future default plugin.
 *
 * Governing designs: `docs/specs/Concepts/Step Keys.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { type CacheStore, Journal } from "@smithers/journal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as JournalRecords from "./internal/JournalRecords.ts"

/**
 * Decision returned by an inconsistency receiver.
 *
 * @category models
 * @since 0.1.0
 */
export type InconsistencyVerdict = "fail" | "tolerate"

/**
 * A content-addressed cache key that produced a result different from the
 * recorded row — a hermeticity/determinism violation.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheConflict {
  readonly key: string
  readonly existing: CacheStore.CacheEntry | undefined
  readonly attempted: CacheStore.CacheEntry
}

/**
 * Inconsistency receiver operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly note: (event: CacheConflict) => Effect.Effect<InconsistencyVerdict, Journal.JournalError>
}

/**
 * Service tag for the engine inconsistency receiver.
 *
 * @category services
 * @since 0.1.0
 */
export class Inconsistency extends Context.Service<Inconsistency, Service>()("flows/engine-store/Inconsistency") {}

/**
 * Options for constructing a journaling inconsistency receiver.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly journal: Journal.Service
  readonly verdict: InconsistencyVerdict
}

/**
 * Builds a receiver that journals every conflict under the run that attempted
 * the write and returns a fixed verdict.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Service => ({
  note: Effect.fn("Inconsistency.note")((event) =>
    Effect.as(
      options.journal.emit(JournalRecords.cacheConflict(
        { runId: event.attempted.recordedRunId, sourceId: "flows/engine-store/inconsistency" },
        {
          key: event.key,
          verdict: options.verdict,
          existing: event.existing === undefined ? null : {
            recordedRunId: event.existing.recordedRunId,
            recordedEventSeq: event.existing.recordedEventSeq,
            createdAtMs: event.existing.createdAtMs
          },
          attempted: {
            recordedRunId: event.attempted.recordedRunId,
            recordedEventSeq: event.attempted.recordedEventSeq,
            createdAtMs: event.attempted.createdAtMs
          }
        }
      )),
      options.verdict
    )
  )
})

/**
 * Builds a receiver from overrides. The default notes nothing and tolerates.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  note: Effect.fn("Inconsistency.note")(() => Effect.succeed("tolerate" as const)),
  ...overrides
})

/**
 * Provides a receiver that never journals and always tolerates.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Inconsistency> =>
  Layer.succeed(Inconsistency)(makeNoop(overrides))

/**
 * Journals every cache conflict and fails the run. This is the default
 * receiver for engine wiring: a non-hermetic sealed hard-boundary activity is
 * a defect, not a condition to paper over.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerStrict: Layer.Layer<Inconsistency, never, Journal.Journal> = Layer.effect(Inconsistency)(
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    return make({ journal, verdict: "fail" })
  })
)

/**
 * Journals every cache conflict and continues, preserving the first-recorded
 * row (Skyframe's tolerant production configuration).
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTolerant: Layer.Layer<Inconsistency, never, Journal.Journal> = Layer.effect(Inconsistency)(
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    return make({ journal, verdict: "tolerate" })
  })
)
