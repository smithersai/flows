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
 * An isolated execution produced a diff bundle. Required by
 * `docs/specs/Concepts/Forensics.md`: the bundle's content address is recorded
 * before it can reach the host, so what was proposed is auditable
 * independently of whether it was applied.
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
