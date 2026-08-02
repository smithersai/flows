import { Database, TestDatabase } from "@smithers/database"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describe, expect, it } from "vitest"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as Migrations from "../src/Migrations.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const migrated = <A, E>(effect: Effect.Effect<A, E, Database.Database | CacheStore>) =>
  run(
    effect.pipe(
      Effect.provide(CacheStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer)
    )
  )

const entry = {
  keyDigest: "digest-1",
  result: { output: "ok" },
  meta: { source: "recorded" },
  createdAtMs: 10,
  recordedRunId: "run-1",
  recordedEventSeq: 7
} as const

const failingDatabase = (cause: unknown): Layer.Layer<Database.Database> => {
  const sql = new Proxy(
    () => Effect.fail(cause),
    { apply: () => Effect.fail(cause) }
  ) as unknown as SqlClient.SqlClient
  const write: Database.DatabaseService["write"] = (effect) => effect
  return Layer.succeed(Database.Database)(
    Database.Database.of({ sql, write })
  )
}

/**
 * A database whose `.raw` results carry node-postgres' `{rowCount}` shape
 * instead of the SQLite drivers' `{changes}`, one result per statement.
 */
const postgresShapedDatabase = (
  results: ReadonlyArray<unknown>
): Layer.Layer<Database.Database> => {
  let next = 0
  const sql = (() => ({ raw: Effect.sync(() => results[next++]) })) as unknown as SqlClient.SqlClient
  const write: Database.DatabaseService["write"] = (effect) => effect
  return Layer.succeed(Database.Database)(
    Database.Database.of({ sql, write })
  )
}

describe("CacheStore", () => {
  it("returns none for a cache miss", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      return yield* store.get("missing")
    }))

    expect(Option.isNone(result)).toBe(true)
  })

  it("records an entry and returns its recorded provenance", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      const put = yield* store.put(entry)
      const found = yield* store.get(entry.keyDigest)
      return { put, found }
    }))

    expect(result.put).toEqual({ _tag: "Inserted" })
    expect(Option.getOrThrow(result.found)).toEqual(entry)
  })

  it("recognizes an identical re-put", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      return yield* store.put(entry)
    }))

    expect(result).toEqual({ _tag: "ExistingSame" })
  })

  it("rejects a different result under an existing digest without replacing it", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      const put = yield* store.put({ ...entry, result: { output: "different" } })
      const found = yield* store.get(entry.keyDigest)
      return { put, found }
    }))

    expect(result.put).toEqual({ _tag: "Conflict" })
    expect(Option.getOrThrow(result.found).result).toEqual({ output: "ok" })
  })

  it("evicts an entry", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      yield* store.evict(entry.keyDigest)
      return yield* store.get(entry.keyDigest)
    }))

    expect(Option.isNone(result)).toBe(true)
  })

  it("fences an eviction on the row's recorded provenance", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      // A foreign process replaced the row between the poisoned read and the
      // delete: the compare-and-swap must be a no-op, not drop the fresh row.
      const stale = yield* store.evict(entry.keyDigest, {
        ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq + 1 }
      })
      const survived = yield* store.get(entry.keyDigest)
      const matching = yield* store.evict(entry.keyDigest, {
        ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
      })
      const gone = yield* store.get(entry.keyDigest)
      return { stale, survived, matching, gone }
    }))

    expect(result.stale).toBe(false)
    expect(Option.isSome(result.survived)).toBe(true)
    expect(result.matching).toBe(true)
    expect(Option.isNone(result.gone)).toBe(true)
  })

  it("fences an eviction on the recording run, not the event seq alone", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      yield* store.put(entry)
      // Sequence numbers are per-run, so a foreign run's provenance collides
      // on `eventSeq` routinely. Only the run half of the compare-and-swap
      // tells the two recordings apart (issue #135).
      const foreign = yield* store.evict(entry.keyDigest, {
        ifRecordedBy: { runId: "foreign-run", eventSeq: entry.recordedEventSeq }
      })
      const survived = yield* store.get(entry.keyDigest)
      return { foreign, survived }
    }))

    expect(result.foreign).toBe(false)
    expect(Option.isSome(result.survived)).toBe(true)
  })

  it("counts affected rows on a driver that reports rowCount rather than changes", async () => {
    // node-postgres hands `.raw` back a `{rowCount}` result; a bun:sqlite
    // `{changes}` cast reads `undefined` there and reports every successful
    // delete as a no-op (issue #134).
    const evicted = await run(
      Effect.gen(function*() {
        const store = yield* CacheStore
        return yield* Effect.all([store.evict("digest-1"), store.evict("digest-2")])
      }).pipe(
        Effect.provide(CacheStoreLive.layer),
        Effect.provide(postgresShapedDatabase([{ rowCount: 1, rows: [] }, { rowCount: 0, rows: [] }]))
      )
    )

    expect(evicted).toEqual([true, false])
  })

  it("rejects empty keys and non-JSON values with invalid_cache", async () => {
    const failures = await migrated(Effect.gen(function*() {
      const store = yield* CacheStore
      return yield* Effect.all([
        Effect.flip(store.get("")),
        Effect.flip(store.put({ ...entry, keyDigest: "" })),
        Effect.flip(store.put({ ...entry, result: undefined })),
        Effect.flip(store.put({ ...entry, result: BigInt(1) })),
        Effect.flip(store.put({ ...entry, meta: undefined })),
        Effect.flip(store.put({ ...entry, meta: BigInt(1) })),
        Effect.flip(store.evict(""))
      ])
    }))

    expect(failures.every((failure) => failure.code === "invalid_cache")).toBe(true)
    expect(failures.some((failure) => failure.cause !== undefined)).toBe(true)
    expect(failures.some((failure) => failure.cause === undefined)).toBe(true)
  })

  it("rejects every invalid provenance field before persistence", async () => {
    const result = await migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      const store = yield* CacheStore
      const invalidEntries: ReadonlyArray<CacheStoreLive.CacheEntry> = [
        { ...entry, createdAtMs: -1 },
        { ...entry, createdAtMs: 0.5 },
        { ...entry, createdAtMs: Number.MAX_SAFE_INTEGER + 1 },
        { ...entry, recordedRunId: "" },
        { ...entry, recordedEventSeq: -1 },
        { ...entry, recordedEventSeq: 0.5 },
        { ...entry, recordedEventSeq: Number.MAX_SAFE_INTEGER + 1 }
      ]
      const failures = yield* Effect.forEach(invalidEntries, (invalid) => Effect.flip(store.put(invalid)))
      const rows = yield* database.sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM flows_step_cache
      `
      return { failures, count: rows[0]!.count }
    }))

    expect(result.failures.map((failure) => failure.code)).toEqual(
      Array.from({ length: 7 }, () => "invalid_cache")
    )
    expect(result.count).toBe(0)
  })

  it("reports decode_failed for corrupt durable cache JSON", async () => {
    const codes = await migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      const store = yield* CacheStore
      yield* store.put(entry)
      yield* database.sql`PRAGMA ignore_check_constraints = ON`
      const codes: Array<string> = []
      for (const column of ["result_json", "meta_json"] as const) {
        yield* database.sql.unsafe(
          `UPDATE flows_step_cache SET ${column} = 'not-json' WHERE key_digest = 'digest-1'`
        )
        const failure = yield* Effect.flip(store.get(entry.keyDigest))
        codes.push(failure.code)
        yield* database.sql.unsafe(
          `UPDATE flows_step_cache SET ${column} = '{}' WHERE key_digest = 'digest-1'`
        )
      }
      yield* database.sql`PRAGMA ignore_check_constraints = OFF`
      return codes
    }))

    expect(codes).toEqual(["decode_failed", "decode_failed"])
  })

  it("decodes complete durable cache rows before exposing provenance", async () => {
    const codes = await migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      const store = yield* CacheStore
      yield* store.put(entry)
      yield* database.sql`PRAGMA ignore_check_constraints = ON`
      const corruptions = [
        ["created_at_ms", "'bad'", "10"],
        ["recorded_run_id", "''", "'run-1'"],
        ["recorded_event_seq", "-1", "7"]
      ] as const
      const failures = yield* Effect.forEach(corruptions, ([column, value, restore]) =>
        Effect.gen(function*() {
          yield* database.sql.unsafe(
            `UPDATE flows_step_cache SET ${column} = ${value} WHERE key_digest = 'digest-1'`
          )
          const failure = yield* Effect.flip(store.get(entry.keyDigest))
          yield* database.sql.unsafe(
            `UPDATE flows_step_cache SET ${column} = ${restore} WHERE key_digest = 'digest-1'`
          )
          return failure.code
        }))
      yield* database.sql`PRAGMA ignore_check_constraints = OFF`
      return failures
    }))

    expect(codes).toEqual(["decode_failed", "decode_failed", "decode_failed"])
  })

  it("normalizes persistence failures into stable error codes", async () => {
    const existing = new CacheStoreLive.CacheStoreError({
      code: "unknown",
      message: "existing"
    })
    const causes: ReadonlyArray<unknown> = [
      existing,
      new SqlError.SqlError({
        reason: new SqlError.ConstraintError({ cause: new Error("constraint") })
      }),
      new SqlError.SqlError({
        reason: new SqlError.UniqueViolation({ cause: new Error("unique"), constraint: "cache" })
      }),
      new Database.DatabaseError({ code: "constraint" }),
      { code: "other" },
      {},
      null,
      "failure"
    ]
    const codes = await Effect.runPromise(
      Effect.forEach(
        causes,
        (cause) =>
          Effect.gen(function*() {
            const store = yield* CacheStore
            return (yield* Effect.flip(store.get("digest"))).code
          }).pipe(
            Effect.provide(CacheStoreLive.layer),
            Effect.provide(failingDatabase(cause))
          )
      )
    )

    expect(codes).toEqual([
      "unknown",
      "constraint",
      "constraint",
      "constraint",
      "persistence_failed",
      "persistence_failed",
      "persistence_failed",
      "persistence_failed"
    ])
  })
})
