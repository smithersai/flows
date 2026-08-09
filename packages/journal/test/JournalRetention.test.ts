import { Database } from "@smthrs/database/Database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { describe, expect, it } from "vitest"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const run = runId("run")
const source = sourceId("producer")

const input = (sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sourceSeq(sequence),
    eventType: "event",
    payload: { value: sequence }
  }, { disableChecks: true })

const effect = <E>(name: string, body: () => Effect.Effect<void, E, Database>) =>
  it(name, () =>
    Effect.runPromise(
      body().pipe(
        Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
        Effect.provide(TestClock.layer())
      )
    ))

/** Records every compiled statement so the startup load can be inspected. */
const recordingDatabase = (
  queries: Array<string>
): Layer.Layer<Database, never, Database> =>
  Layer.effect(
    Database,
    Effect.gen(function*() {
      const database = yield* Database
      const sql = new Proxy(database.sql, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (typeof statement.compile === "function") {
            queries.push(statement.compile()[0])
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return Database.of({ sql, write: database.write })
    })
  )

const journal = (
  options: SqlJournal.SqlJournalOptions,
  database?: Layer.Layer<Database, never, Database>
) =>
  database === undefined
    ? SqlJournal.layer(options)
    : SqlJournal.layer(options).pipe(Layer.provide(database))

const eventCount = Effect.gen(function*() {
  const database = yield* Database
  const rows = yield* database.sql<{ readonly total: number }>`
    SELECT COUNT(*) AS total FROM flows_journal_events
  `
  return Number(rows[0]!.total)
})

const seed = (count: number, options: SqlJournal.SqlJournalOptions) =>
  Effect.gen(function*() {
    const service = yield* Journal
    for (let index = 0; index < count; index++) {
      yield* service.emitLossy(input(index))
    }
    yield* service.flush
  }).pipe(Effect.provide(journal(options)), Effect.scoped)

describe("SqlJournal source-event retention", () => {
  effect("bounds the startup load instead of decoding every historical event", () =>
    Effect.gen(function*() {
      yield* seed(6, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        return {
          oldest: yield* service.emitLossy(input(0)),
          newest: yield* service.emitLossy(input(5))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )
      const load = queries.find((query) =>
        query.includes("FROM flows_journal_events") && !query.includes("MAX(") && !query.includes("INSERT")
      )
      expect(load).toBeDefined()
      expect(load).toContain("LIMIT")
      // The retained window answers from memory; everything older falls through
      // to the durable duplicate check in the writer.
      expect(receipts.newest._tag).toBe("Duplicate")
      expect(receipts.oldest._tag).toBe("Accepted")
      // The fall-through never duplicates a durable row.
      expect(yield* eventCount).toBe(6)
    }))

  effect("evicts committed entries once the index exceeds the bound", () =>
    Effect.gen(function*() {
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 5; index++) {
          yield* service.emitLossy(input(index))
        }
        yield* service.flush
        return {
          oldest: yield* service.emitLossy(input(0)),
          newest: yield* service.emitLossy(input(4))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
        Effect.scoped
      )
      expect(receipts.newest._tag).toBe("Duplicate")
      expect(receipts.oldest._tag).toBe("Accepted")
      expect(yield* eventCount).toBe(5)
    }))

  effect("never evicts an uncommitted entry, so pending dedup still holds", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const database = Layer.effect(
        Database,
        Effect.gen(function*() {
          const inner = yield* Database
          return Database.of({
            sql: inner.sql,
            write: (write) => Deferred.await(gate).pipe(Effect.andThen(inner.write(write)))
          })
        })
      )
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 4; index++) {
          yield* service.emitLossy(input(index))
        }
        const observed = yield* Effect.forEach([0, 1, 2, 3], (index) => service.emitLossy(input(index)))
        yield* Deferred.succeed(gate, undefined)
        yield* service.flush
        return observed
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 1 }, database)),
        Effect.scoped
      )
      expect(receipts.map((receipt) => receipt._tag)).toEqual([
        "Duplicate",
        "Duplicate",
        "Duplicate",
        "Duplicate"
      ])
    }))

  effect("rejects a non-positive source-event cache bound", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.provide(Effect.void, journal({ capacity: 8, overflow: "reject", sourceEventCache: 0 }))
        )
      )
      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("invalid_event")
    }))
})
