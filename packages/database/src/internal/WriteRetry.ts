/**
 * SQLite write retry policy.
 *
 * Governing persistence design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * Adapted from smithers `packages/db/src/withSqliteWriteRetryEffect.js`:
 * retry only structured transient SQLite failures, bound exponential delay,
 * and use Effect scheduling so interruption and `TestClock` remain native.
 *
 * @since 0.1.0
 */
import { Duration, Effect, Schedule } from "effect"
import * as SqlError from "effect/unstable/sql/SqlError"

/**
 * Configuration for SQLite write retries.
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

const sqliteCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" ? code : undefined
}

const hasRetryableSqliteCause = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const code = sqliteCode(current)
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : ""
    if (
      code?.startsWith("SQLITE_BUSY") ||
      code?.startsWith("SQLITE_LOCKED") ||
      code?.startsWith("SQLITE_IOERR") ||
      message.includes("database is locked") ||
      message.includes("database is busy") ||
      message.includes("disk i/o error")
    ) {
      return true
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

/**
 * Returns whether a structured SQL failure represents a transient SQLite write
 * conflict or I/O error. Constraint, syntax, and arbitrary application errors
 * are deliberately never retried.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRetryableSqliteWriteError = (error: unknown): error is SqlError.SqlError =>
  SqlError.isSqlError(error) &&
  (error.reason._tag === "LockTimeoutError" || hasRetryableSqliteCause(error.reason.cause))

/**
 * Retries recognized transient SQLite write errors using exponential backoff
 * and jitter. Delays use Effect's Clock and therefore work with TestClock.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withSqliteWriteRetry = <A, E, R>(
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
  return Effect.retry(effect, { schedule, while: isRetryableSqliteWriteError })
}
