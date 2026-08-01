/**
 * Thin database service: an SQL client plus transaction-scoped write retries.
 *
 * Governing persistence designs:
 * `docs/specs/Concepts/Journal Queue.md` and
 * `docs/specs/Concepts/Run Ownership.md`.
 *
 * The client/layer seam follows Effect SQL's SQLite node, Bun, and WASM
 * packages. Domain schema and operations remain in `@smithers/journal`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Schema } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as WriteRetry from "./internal/WriteRetry.ts"

/**
 * Stable categories exposed for database failures.
 *
 * @category models
 * @since 0.1.0
 */
export const DatabaseErrorCode = Schema.Literals(["busy", "constraint", "io", "unsupported", "unknown"])

/**
 * Stable database failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type DatabaseErrorCode = typeof DatabaseErrorCode.Type

/**
 * A normalized database error suitable for consumers outside a driver.
 *
 * @category errors
 * @since 0.1.0
 */
export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("flows/database/DatabaseError", {
  code: DatabaseErrorCode,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Generic database access, deliberately free of journal or Host knowledge.
 *
 * @category services
 * @since 0.1.0
 */
export class Database extends Context.Service<Database, {
  readonly sql: SqlClient.SqlClient
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DatabaseError, R>
}>()("flows/database/Database") {}

/**
 * Runtime implementation shape for the Database service.
 *
 * @category models
 * @since 0.1.0
 */
export interface DatabaseService {
  readonly sql: SqlClient.SqlClient
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DatabaseError, R>
}

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined
  }
  const code = cause.code
  return typeof code === "string" ? code : undefined
}

// Postgres reports a lost write race as a SQLSTATE rather than a lock error,
// so it maps to the same stable `busy` category a SQLITE_BUSY does; a caller
// that branches on the code sees one vocabulary across dialects (issue #78).
const busyPostgresStates = new Set(["40001", "40P01", "55P03"])

const hasCause = (cause: unknown, match: (code: string | undefined, message: string) => boolean): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = "message" in current && typeof current.message === "string" ? current.message.toLowerCase() : ""
    if (match(causeCode(current), message)) {
      return true
    }
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

const hasIoCause = (cause: unknown): boolean =>
  hasCause(cause, (code, message) => code?.startsWith("SQLITE_IOERR") === true || message.includes("disk i/o error"))

const hasBusyCause = (cause: unknown): boolean =>
  hasCause(
    cause,
    (code, message) =>
      (code !== undefined && busyPostgresStates.has(code)) ||
      message.includes("could not serialize access") ||
      message.includes("deadlock detected")
  )

/**
 * Converts an Effect SQL error into the package's stable error vocabulary.
 *
 * @category converting
 * @since 0.1.0
 */
export const fromSqlError = (error: SqlError.SqlError): DatabaseError =>
  new DatabaseError({
    code: error.reason._tag === "LockTimeoutError" ?
      "busy" :
      error.reason._tag === "ConstraintError" || error.reason._tag === "UniqueViolation" ?
      "constraint" :
      hasIoCause(error.reason.cause)
      ? "io"
      : hasBusyCause(error.reason.cause)
      ? "busy"
      : "unknown",
    cause: error
  })

/**
 * Builds the database service around an existing SQL client.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (sql: SqlClient.SqlClient, options?: WriteRetry.WriteRetryOptions | undefined): DatabaseService =>
  Database.of({
    sql,
    write: Effect.fn("Database.write")(<A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | DatabaseError, R> =>
      WriteRetry.withWriteRetry(sql.withTransaction(effect), options).pipe(
        Effect.catchIf(SqlError.isSqlError, (error) => Effect.fail(fromSqlError(error)))
      )
    )
  })

const unsupportedSql = new Proxy(
  () => Effect.fail(new DatabaseError({ code: "unsupported" })),
  {
    get: () => () => Effect.fail(new DatabaseError({ code: "unsupported" }))
  }
) as unknown as SqlClient.SqlClient

/**
 * Builds a database stub whose SQL and writes fail with `unsupported`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): DatabaseService =>
  Database.of({
    sql: unsupportedSql,
    write: Effect.fn("Database.write")(() => Effect.fail(new DatabaseError({ code: "unsupported" })))
  })

/**
 * Provides the unsupported database stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Database> = Layer.succeed(Database)(makeNoop())
