/**
 * Write retry policy.
 *
 * Governing persistence design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * Adapted from smithers `packages/db/src/withSqliteWriteRetryEffect.js`:
 * retry only structured transient failures, bound exponential delay, and use
 * Effect scheduling so interruption and `TestClock` remain native.
 *
 * Classification is dialect-blind by construction. `Database.make` accepts any
 * `SqlClient`, so a caller can already hand it a Postgres or PGlite client;
 * keying only off SQLite codes made the retry silently inert there, and a
 * serialization failure — the normal, expected outcome of two drivers fencing
 * one run — surfaced as a hard write error (issue #78). Both vocabularies are
 * recognised, and a code from the wrong dialect simply never matches.
 *
 * @since 0.1.0
 */
import { Duration, Effect, Schedule } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"

/**
 * Configuration for write retries.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteRetryOptions {
  /** Total attempts, including the initial write. */
  readonly maxAttempts?: number | undefined
  /** Initial exponential backoff delay in milliseconds. */
  readonly baseDelayMs?: number | undefined
  /** Upper bound for a single retry delay in milliseconds. */
  readonly maxDelayMs?: number | undefined
}

const defaultMaxAttempts = 10
const defaultBaseDelayMs = 50
const defaultMaxDelayMs = 10_000

const boundedPositiveInteger = (value: number | undefined, fallback: number): number =>
  Math.max(1, Math.floor(value ?? fallback))

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" ? code : undefined
}

/**
 * Postgres SQLSTATEs a write may legitimately be replayed on:
 * `40001` serialization_failure, `40P01` deadlock_detected, `55P03`
 * lock_not_available. `23505` (unique_violation) is deliberately absent — it
 * is the first-writer-wins signal the stores decide on, not a transient fault.
 */
const retryablePostgresStates = new Set(["40001", "40P01", "55P03"])

const isRetryableCode = (code: string | undefined): boolean =>
  code !== undefined &&
  (code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    code.startsWith("SQLITE_IOERR") ||
    retryablePostgresStates.has(code))

// PGlite runs Postgres in-process and does not always surface a SQLSTATE, so
// the canonical server texts are matched too.
const isRetryableMessage = (message: string): boolean =>
  message.includes("database is locked") ||
  message.includes("database is busy") ||
  message.includes("disk i/o error") ||
  message.includes("could not serialize access") ||
  message.includes("deadlock detected")

const hasRetryableCause = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : ""
    if (isRetryableCode(causeCode(current)) || isRetryableMessage(message)) {
      return true
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

/**
 * Returns whether a structured SQL failure represents a transient write
 * conflict or I/O error, in either the SQLite or the Postgres vocabulary.
 * Constraint, syntax, and arbitrary application errors are deliberately never
 * retried.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRetryableWriteError = (error: unknown): error is SqlError.SqlError =>
  SqlError.isSqlError(error) &&
  (error.reason._tag === "LockTimeoutError" || hasRetryableCause(error.reason.cause))

/**
 * Retries recognized transient write errors using exponential backoff and
 * jitter. Delays use Effect's Clock and therefore work with TestClock.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withWriteRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: WriteRetryOptions | undefined
): Effect.Effect<A, E, R> => {
  const maxAttempts = boundedPositiveInteger(options?.maxAttempts, defaultMaxAttempts)
  const baseDelayMs = boundedPositiveInteger(options?.baseDelayMs, defaultBaseDelayMs)
  const maxDelayMs = boundedPositiveInteger(options?.maxDelayMs, defaultMaxDelayMs)
  const schedule = Schedule.exponential(Duration.millis(baseDelayMs)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.millis(Math.min(maxDelayMs, Duration.toMillis(duration))))
    ),
    Schedule.jittered,
    Schedule.upTo({ times: maxAttempts - 1 })
  )
  return Effect.retry(effect, { schedule, while: isRetryableWriteError })
}
