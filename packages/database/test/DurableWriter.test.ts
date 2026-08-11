import { Cause, Effect, Exit, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describe, expect, it } from "vitest"
import * as DurableWriter from "../src/DurableWriter.ts"
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

// Mimics the real client's transaction shape: `withTransaction` provides the
// client's transaction service, which is how `write` detects nesting.
const retryTransaction = SqlClient.TransactionConnection(-1)
const retrySql = {
  transactionService: retryTransaction,
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, retryTransaction, [undefined as never, 0])
} as SqlClient.SqlClient

describe("DurableWriter", () => {
  it("opens, queries, and commits a transaction through TestDatabase", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        yield* sql`CREATE TABLE values_table (value INTEGER NOT NULL)`
        yield* writer.write(sql`INSERT INTO values_table (value) VALUES (${42})`)
        const rows = yield* sql<{ readonly value: number }>`SELECT value FROM values_table`
        return rows[0]?.value
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(result).toBe(42)
  })

  it("reads the affected-row count from either dialect's raw result", async () => {
    const counts = await Effect.runPromise(
      Effect.all([
        DurableWriter.affectedRows({ changes: 3 }),
        DurableWriter.affectedRows({ rowCount: 0 }),
        // A driver that reports both wins on the SQLite field it already used.
        DurableWriter.affectedRows({ changes: 2, rowCount: 5 })
      ])
    )

    expect(counts).toEqual([3, 0, 2])
  })

  it("fails with unsupported rather than guessing when no affected-row count is readable", async () => {
    const shapes: ReadonlyArray<unknown> = [
      undefined,
      null,
      "1 row",
      {},
      { changes: "3" },
      { changes: -1 },
      { rowCount: 1.5 }
    ]
    const failures = await Effect.runPromise(
      Effect.forEach(shapes, (shape) => Effect.flip(DurableWriter.affectedRows(shape)))
    )

    expect(failures.map((failure) => failure.code)).toEqual(shapes.map(() => "unsupported"))
  })

  it("normalizes SQLite errors into stable DatabaseError codes", () => {
    expect(DurableWriter.fromSqlError(sqliteError("SQLITE_BUSY"))).toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(sqliteError("SQLITE_CONSTRAINT"))).toMatchObject({ code: "constraint" })
    expect(DurableWriter.fromSqlError(sqliteError("SQLITE_IOERR"))).toMatchObject({ code: "io" })
    expect(
      DurableWriter.fromSqlError(
        new SqlError.SqlError({
          reason: new SqlError.UniqueViolation({ cause: {}, constraint: "unique_key" })
        })
      )
    ).toMatchObject({ code: "constraint" })
    expect(DurableWriter.fromSqlError(unknownSqlError("plain failure"))).toMatchObject({ code: "unknown" })
    expect(DurableWriter.fromSqlError(unknownSqlError({}))).toMatchObject({ code: "unknown" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: 5, message: "disk I/O error" }))).toMatchObject({
      code: "io"
    })
    expect(DurableWriter.fromSqlError(unknownSqlError({ cause: { code: "SQLITE_IOERR_NOMEM" } }))).toMatchObject({
      code: "io"
    })

    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(DurableWriter.fromSqlError(unknownSqlError(cyclic))).toMatchObject({ code: "unknown" })
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

  // `DurableWriter.make` accepts any SqlClient, so a caller can already supply a
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
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "40001" }))).toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "40P01" }))).toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "42P01" }))).toMatchObject({ code: "unknown" })
  })

  it("retries a Postgres serialization failure through the same schedule", async () => {
    let attempts = 0
    const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
    const program = Effect.gen(function*() {
      const fiber = yield* writer.write(
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
    const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
    const program = Effect.gen(function*() {
      const fiber = yield* writer.write(
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

  it("classifies a transient failure through a wrapping domain error's cause chain", () => {
    expect(WriteRetry.isRetryableWriteError({ _tag: "StoreError", cause: sqliteError("SQLITE_BUSY") })).toBe(true)
    expect(WriteRetry.isRetryableWriteError({ _tag: "StoreError", cause: sqliteError("SQLITE_CONSTRAINT") }))
      .toBe(false)
    expect(
      WriteRetry.isRetryableWriteError(
        DurableWriter.fromSqlError(sqliteError("SQLITE_BUSY"))
      )
    ).toBe(true)
  })

  it("does not retry a nested write; only the outermost transaction replays", async () => {
    let outerBodies = 0
    let innerBodies = 0
    const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
    const program = Effect.gen(function*() {
      const fiber = yield* writer.write(
        Effect.suspend(() => {
          outerBodies += 1
          return writer.write(
            Effect.suspend(() => {
              innerBodies += 1
              return innerBodies < 3 ? Effect.fail(sqliteError("SQLITE_BUSY")) : Effect.succeed("written")
            })
          )
        })
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))

    await expect(Effect.runPromise(program)).resolves.toBe("written")
    // Each transient conflict replays the whole outer transaction; the nested
    // write never replays its savepoint alone.
    expect(outerBodies).toBe(3)
    expect(innerBodies).toBe(3)
  })

  it("replays the outermost transaction when a domain error wraps the transient failure", async () => {
    let attempts = 0
    const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
    const program = Effect.gen(function*() {
      const fiber = yield* writer.write(
        Effect.suspend(() => {
          attempts += 1
          return attempts < 3
            ? Effect.fail({ _tag: "StoreError", cause: sqliteError("SQLITE_BUSY") } as const)
            : Effect.succeed("written")
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
    const writer = DurableWriter.make(retrySql, { maxAttempts: 3 })
    const exit = await Effect.runPromiseExit(
      writer.write(
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
        const writer = yield* DurableWriter.DurableWriter
        return yield* writer.write(Effect.void)
      }).pipe(Effect.provide(DurableWriter.layerNoop))
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

  it("makeNoop fails writes with unsupported", async () => {
    const writer = DurableWriter.makeNoop()
    const exit = await Effect.runPromiseExit(writer.write(Effect.void))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const found = Cause.findError(exit.cause)
      expect(Result.isSuccess(found) && found.success instanceof DurableWriter.DatabaseError).toBe(true)
      if (Result.isSuccess(found) && found.success instanceof DurableWriter.DatabaseError) {
        expect(found.success.code).toBe("unsupported")
      }
    }
  })
})
