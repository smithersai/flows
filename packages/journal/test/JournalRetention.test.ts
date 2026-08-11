import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
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

const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, DurableWriter | SqlClient.SqlClient>
) =>
  it(name, () =>
    Effect.runPromise(
      body().pipe(
        Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
        Effect.provide(TestClock.layer())
      )
    ))

/** A database decorator: reshapes the enclosing client/writer pair in place. */
type DatabaseDecorator = Layer.Layer<
  DurableWriter | SqlClient.SqlClient,
  never,
  DurableWriter | SqlClient.SqlClient
>

const keepWriter: Layer.Layer<DurableWriter, never, DurableWriter> = Layer.effect(
  DurableWriter,
  Effect.service(DurableWriter)
)

const keepSql: Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> = Layer.effect(
  SqlClient.SqlClient,
  Effect.service(SqlClient.SqlClient)
)

/** Records every compiled statement so the startup load can be inspected. */
const recordingDatabase = (queries: Array<string>): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile === "function") {
              queries.push(statement.compile()[0])
            }
            return statement
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

const journal = (
  options: SqlJournal.SqlJournalOptions,
  database?: DatabaseDecorator
) =>
  database === undefined
    ? SqlJournal.layer(options)
    : SqlJournal.layer(options).pipe(Layer.provide(database))

const eventCount = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly total: number }>`
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
      const database: DatabaseDecorator = Layer.merge(
        Layer.effect(
          DurableWriter,
          Effect.gen(function*() {
            const inner = yield* DurableWriter
            return DurableWriter.of({
              write: (write) => Deferred.await(gate).pipe(Effect.andThen(inner.write(write)))
            })
          })
        ),
        keepSql
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
