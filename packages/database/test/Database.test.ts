import { Cause, Effect, Exit, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describe, expect, it } from "vitest"
import * as Database from "../src/Database.ts"
import * as WriteRetry from "../src/internal/WriteRetry.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const sqliteError = (code: string): SqlError.SqlError =>
  new SqlError.SqlError({
    reason: SqlError.classifySqliteError(Object.assign(new Error(code), { code }))
  })

const unknownSqlError = (cause: unknown): SqlError.SqlError =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({ cause })
  })

const retrySql = {
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
} as SqlClient.SqlClient

describe("Database", () => {
  it("opens, queries, and commits a transaction through TestDatabase", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const database = yield* Database.Database
        yield* database.sql`CREATE TABLE values_table (value INTEGER NOT NULL)`
        yield* database.write(database.sql`INSERT INTO values_table (value) VALUES (${42})`)
        const rows = yield* database.sql<{ readonly value: number }>`SELECT value FROM values_table`
        return rows[0]?.value
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(result).toBe(42)
  })

  it("normalizes SQLite errors into stable DatabaseError codes", () => {
    expect(Database.fromSqlError(sqliteError("SQLITE_BUSY"))).toMatchObject({ code: "busy" })
    expect(Database.fromSqlError(sqliteError("SQLITE_CONSTRAINT"))).toMatchObject({ code: "constraint" })
    expect(Database.fromSqlError(sqliteError("SQLITE_IOERR"))).toMatchObject({ code: "io" })
    expect(
      Database.fromSqlError(
        new SqlError.SqlError({
          reason: new SqlError.UniqueViolation({ cause: {}, constraint: "unique_key" })
        })
      )
    ).toMatchObject({ code: "constraint" })
    expect(Database.fromSqlError(unknownSqlError("plain failure"))).toMatchObject({ code: "unknown" })
    expect(Database.fromSqlError(unknownSqlError({}))).toMatchObject({ code: "unknown" })
    expect(Database.fromSqlError(unknownSqlError({ code: 5, message: "disk I/O error" }))).toMatchObject({
      code: "io"
    })
    expect(Database.fromSqlError(unknownSqlError({ cause: { code: "SQLITE_IOERR_NOMEM" } }))).toMatchObject({
      code: "io"
    })

    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(Database.fromSqlError(unknownSqlError(cyclic))).toMatchObject({ code: "unknown" })
  })

  it("recognizes only structured transient SQLite write failures", () => {
    expect(WriteRetry.isRetryableWriteError("database is busy")).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError("plain failure"))).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: 5, message: "database is locked" })))
      .toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ message: "database is busy" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ message: "disk I/O error" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ cause: { code: "SQLITE_LOCKED_SHAREDCACHE" } })))
      .toBe(true)

    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(WriteRetry.isRetryableWriteError(unknownSqlError(cyclic))).toBe(false)
  })

  // `Database.make` accepts any SqlClient, so a caller can already supply a
  // Postgres or PGlite client. Classification keyed only off SQLite codes made
  // the retry silently inert there, so a serialization failure surfaced as a
  // hard write error instead of being replayed (issue #78).
  it("recognizes transient Postgres write failures by SQLSTATE", () => {
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "40001" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "40P01" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "55P03" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ cause: { code: "40001" } }))).toBe(true)
    // A serialization failure raised as text by PGlite, which does not always
    // carry a SQLSTATE through the wire-less driver.
    expect(
      WriteRetry.isRetryableWriteError(
        unknownSqlError({ message: "could not serialize access due to concurrent update" })
      )
    ).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ message: "deadlock detected" }))).toBe(true)
    // Not transient: a unique violation must stay a first-writer-wins signal,
    // and 42P01 is a missing relation.
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "23505" }))).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "42P01" }))).toBe(false)
  })

  it("normalizes transient Postgres failures into the busy code", () => {
    expect(Database.fromSqlError(unknownSqlError({ code: "40001" }))).toMatchObject({ code: "busy" })
    expect(Database.fromSqlError(unknownSqlError({ code: "40P01" }))).toMatchObject({ code: "busy" })
    expect(Database.fromSqlError(unknownSqlError({ code: "42P01" }))).toMatchObject({ code: "unknown" })
  })

  it("retries a Postgres serialization failure through the same schedule", async () => {
    let attempts = 0
    const database = Database.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
    const program = Effect.gen(function*() {
      const fiber = yield* database.write(
        Effect.suspend(() => {
          attempts += 1
          return attempts < 3 ? Effect.fail(unknownSqlError({ code: "40001" })) : Effect.succeed("written")
        })
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))

    await expect(Effect.runPromise(program)).resolves.toBe("written")
    expect(attempts).toBe(3)
  })

  it("retries transient write errors using TestClock", async () => {
    let attempts = 0
    const database = Database.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
    const program = Effect.gen(function*() {
      const fiber = yield* database.write(
        Effect.suspend(() => {
          attempts += 1
          return attempts < 3 ? Effect.fail(sqliteError("SQLITE_BUSY")) : Effect.succeed("written")
        })
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))

    await expect(Effect.runPromise(program)).resolves.toBe("written")
    expect(attempts).toBe(3)
  })

  it("does not retry constraint failures", async () => {
    let attempts = 0
    const database = Database.make(retrySql, { maxAttempts: 3 })
    const exit = await Effect.runPromiseExit(
      database.write(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail(sqliteError("SQLITE_CONSTRAINT"))
        })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(attempts).toBe(1)
  })

  it("layerNoop fails writes with unsupported", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const database = yield* Database.Database
        return yield* database.write(Effect.void)
      }).pipe(Effect.provide(Database.layerNoop))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.findError(exit.cause)
      expect(Result.isSuccess(error)).toBe(true)
      if (Result.isSuccess(error)) {
        expect(error.success.code).toBe("unsupported")
      }
    }
  })

  it("makeNoop fails SQL calls and SQL client methods with unsupported", async () => {
    const database = Database.makeNoop()
    const queryExit = await Effect.runPromiseExit(database.sql`SELECT 1`)
    const transactionExit = await Effect.runPromiseExit(database.sql.withTransaction(Effect.void))

    const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [queryExit, transactionExit]
    for (const exit of exits) {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const found = Cause.findError(exit.cause)
        expect(Result.isSuccess(found) && found.success instanceof Database.DatabaseError).toBe(true)
        if (Result.isSuccess(found) && found.success instanceof Database.DatabaseError) {
          expect(found.success.code).toBe("unsupported")
        }
      }
    }
  })
})
