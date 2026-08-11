/**
 * Stable engine event constructors over the open journal envelope.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"

/** @since 0.1.0 @category models */
export interface EventOptions {
  readonly runId: string
  readonly sourceId: string
  readonly sourceSeq?: number | undefined
}

const event = (options: EventOptions, eventType: string, payload: unknown): JournalEvent.Input =>
  new JournalEvent.Input({
    runId: options.runId as JournalEvent.RunId,
    sourceId: options.sourceId as JournalEvent.SourceId,
    ...(options.sourceSeq === undefined ? {} : { sourceSeq: options.sourceSeq as JournalEvent.SourceSeq }),
    eventType,
    payload
  })

/** @since 0.1.0 @category events */
export const runDecision = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.run-decision", payload)
/** @since 0.1.0 @category events */
export const attemptStarted = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.attempt-started", payload)
/** @since 0.1.0 @category events */
export const attemptFinished = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.attempt-finished", payload)
/** @since 0.1.0 @category events */
export const deferredCompleted = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.deferred-completed", payload)
/** @since 0.1.0 @category events */
export const clockScheduled = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.clock-scheduled", payload)
/** @since 0.1.0 @category events */
export const interrupted = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.interrupted", payload)
/** @since 0.1.0 @category events */
export const snapshotIdentified = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.snapshot-identified", payload)
/** @since 0.1.0 @category events */
export const hardViolation = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.hard-violation", payload)
/** @since 0.1.0 @category events */
export const expectedSetDeviation = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.expected-set-deviation", payload)
/**
 * An isolated execution produced a diff bundle: its content address, the paths
 * it changed, and the deviations the declaration did not predict. One of the
 * two record types `docs/specs/Concepts/Forensics.md` names for copy-back.
 *
 * It is written once the attempt's copy-back has settled, not before it — the
 * rebase loop owns the window in between, and a bundle that lost every race
 * was never a proposal the host saw. A crash inside that window leaves the
 * attempt row unfinished, so the replay re-executes and journals the bundle it
 * actually applies. An execution the declaration invalidated journals nothing
 * here at all; its `hard-violation` record carries the identity instead.
 *
 * @since 0.1.0
 * @category events
 */
export const diffBundleCaptured = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.diff-bundle-captured", payload)
/**
 * A diff bundle reached the host. Carries the rebase count and the queued
 * effects the dispatch stage then delivered, so a copy-back that raced, or one
 * whose effects fired, is never inferred from an absence.
 *
 * @since 0.1.0
 * @category events
 */
export const copyBackSettled = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.copy-back-settled", payload)
/**
 * A plan was recorded and a run is about to be driven under it. Carries the
 * plan id, its generation-0 digest, and its node count, so
 * `docs/specs/Specs/Plan.md`'s audit question — "show me the plan this ran
 * under" — is answered exactly rather than reconstructed.
 *
 * @since 0.1.0
 * @category events
 */
export const planRecorded = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.plan-recorded", payload)
/**
 * An elaboration appended a pre-keyed subgraph to the SAME plan. The plan
 * grows; it is never invalidated, so this record names the new generation, the
 * advanced digest, and the node ids added — never a replacement graph.
 *
 * @since 0.1.0
 * @category events
 */
export const subgraphAppended = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.subgraph-appended", payload)
/**
 * A plan node was admitted to the scheduler: its caps and seats allowed it,
 * and its effective priority selected it. Paired with `node-settled`, this is
 * the queue-time evidence `docs/specs/Concepts/Concurrency.md` asks the journal
 * to measure.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeScheduled = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.node-scheduled", payload)
/**
 * A plan node reached one of the four evaluation outcomes. Skyframe's
 * `EvaluationProgressReceiver.EvaluationState` is the prior art and the
 * quadruple is deliberately the same size, with one deviation:
 * `SUCCESS_VERSION_CHANGED`/`SUCCESS_VERSION_UNCHANGED` map onto `built`/
 * `clean`, and where Skyframe splits failure by version we use `failed` and
 * `skipped` — a content-addressed store never serves a failure from cache, so
 * `FAIL_VERSION_UNCHANGED` has no analogue, while a dependent that never ran
 * because its cone failed does.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeSettled = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.node-settled", payload)
/**
 * A scheduled node's dispatch identity was invalidated: its measured inputs no
 * longer match the ones its key was computed from, so it is re-keyed and
 * re-dispatched. Invalidation is re-keying — there is no dirty bit and no
 * invalidating visitor to journal.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeInvalidated = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.node-invalidated", payload)
/**
 * The reconciliation seam returned a verdict for a deviation or an unabsorbed
 * materialization conflict.
 *
 * @since 0.1.0
 * @category events
 */
export const nodeReconciled = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.node-reconciled", payload)
/** @since 0.1.0 @category events */
export const cacheProvenance = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.cache-provenance", payload)
/** @since 0.1.0 @category events */
export const cacheConflict = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.cache-conflict", payload)
/** @since 0.1.0 @category events */
export const cacheCorruption = (options: EventOptions, payload: unknown) =>
  event(options, "flows.engine.cache-corruption", payload)

/**
 * Reads a page of engine records without imposing an agent-shaped event union.
 *
 * @since 0.1.0
 * @category queries
 */
export const entries = (runId: string, after: number | undefined, limit: number) =>
  Effect.flatMap(
    Journal.Journal,
    (journal) =>
      journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after: after as JournalEvent.Seq }),
        limit
      })
  )
