import { Database } from "@smithers/database/Database"
import * as TestDatabase from "@smithers/database/test/TestDatabase"
import { Context, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Journal, JournalError, makeNoop, type Service } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown,
  sequence?: SourceSeq
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    ...(sequence === undefined ? {} : { sourceSeq: sequence }),
    eventType,
    payload
  }, { disableChecks: true })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const options: SqlJournal.SqlJournalOptions = { capacity: 8, overflow: "reject" }

const journalLayer = (overrides: Partial<SqlJournal.SqlJournalOptions> = {}) =>
  SqlJournal.layer({ ...options, ...overrides }).pipe(Layer.provideMerge(migratedDatabase))

const withJournal = <A, E>(
  body: Effect.Effect<A, E, Journal | Database>,
  overrides: Partial<SqlJournal.SqlJournalOptions> = {}
) => Effect.scoped(body.pipe(Effect.provide(journalLayer(overrides))))

const seqsOf = (database: Database["Service"], run: RunId) =>
  database.sql<{ readonly seq: number }>`
    SELECT seq FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `

describe("SqlJournal durable emission", () => {
  effect("emitDurable returns a committed sequence", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const database = yield* Database
        const receipt = yield* journal.emitDurable(input(runId("run"), sourceId("s"), "created", { a: 1 }))
        expect(receipt._tag).toBe("Accepted")
        const rows = yield* seqsOf(database, runId("run"))
        expect(rows.map((row) => row.seq)).toEqual([receipt.seq])
      })
    ))

  effect("emitDurable allocates gapless sequences across independent writers", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const database = yield* Database
        const shared = Layer.succeed(Database)(database)
        const build = Effect.map(
          Layer.build(SqlJournal.layer(options).pipe(Layer.provide(shared))),
          (context) => Context.get(context, Journal) as Service
        )
        const left = yield* build
        const right = yield* build
        const run = runId("shared")
        yield* left.emitDurable(input(run, sourceId("left"), "l0", 0))
        yield* right.emitDurable(input(run, sourceId("right"), "r0", 0))
        yield* left.emitDurable(input(run, sourceId("left"), "l1", 1))
        yield* right.emitDurable(input(run, sourceId("right"), "r1", 1))
        const rows = yield* seqsOf(database, run)
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
      }).pipe(Effect.provide(migratedDatabase))
    ))

  effect("emitDurable is idempotent for an exact producer retry", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const first = yield* journal.emitDurable(
          input(runId("run"), sourceId("s"), "created", { a: 1 }, sourceSeq(0))
        )
        const second = yield* journal.emitDurable(
          input(runId("run"), sourceId("s"), "created", { a: 1 }, sourceSeq(0))
        )
        expect(second).toEqual({ _tag: "Duplicate", seq: first.seq, sourceSeq: 0, status: "committed" })
      })
    ))

  effect("emitDurable rejects a reused producer sequence with different content", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurable(input(runId("run"), sourceId("s"), "created", { a: 1 }, sourceSeq(0)))
        const failure = yield* Effect.flip(
          journal.emitDurable(input(runId("run"), sourceId("s"), "created", { a: 2 }, sourceSeq(0)))
        )
        expect(failure).toBeInstanceOf(JournalError)
        expect((failure as JournalError).code).toBe("idempotency_conflict")
      })
    ))

  effect("allocation: sql routes emit through the durable path", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const database = yield* Database
        const receipt = yield* journal.emit(input(runId("run"), sourceId("s"), "created", 1))
        const rows = yield* seqsOf(database, runId("run"))
        expect(rows.map((row) => row.seq)).toEqual([receipt.seq])
      }),
      { allocation: "sql" }
    ))

  effect("durable entries are readable and continue the in-memory clock", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurable(input(runId("run"), sourceId("s"), "created", 1))
        const queued = yield* journal.emit(input(runId("run"), sourceId("s"), "queued", 2))
        expect(queued.seq).toBe(1)
        yield* journal.flush
        const page = yield* journal.entries({ runId: runId("run"), limit: 10 })
        expect(page.entries.map((entry) => entry.seq)).toEqual([0, 1])
      })
    ))

  effect("emitDurable validates its input", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failure = yield* Effect.flip(journal.emitDurable(input(runId(""), sourceId("s"), "x", 1)))
        expect((failure as JournalError).code).toBe("invalid_event")
      })
    ))

  effect("emitDurable rejects a producer sequence at the allocation ceiling", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failure = yield* Effect.flip(
          journal.emitDurable(
            input(runId("run"), sourceId("s"), "x", 1, sourceSeq(Number.MAX_SAFE_INTEGER))
          )
        )
        expect((failure as JournalError).code).toBe("invalid_event")
      })
    ))

  effect("emitDurable rejects a canonical sequence at the allocation ceiling", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const database = yield* Database
        yield* database.sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'run', ${Number.MAX_SAFE_INTEGER - 1}, 'ceiling', 'other', 0, 0, 'x', '1', 'null'
          )
        `
        const failure = yield* Effect.flip(journal.emitDurable(input(runId("run"), sourceId("s"), "x", 1)))
        expect((failure as JournalError).code).toBe("invalid_event")
      })
    ))

  effect("emitDurable reports a failed sink", () =>
    withJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const database = yield* Database
        yield* database.sql`DROP TABLE flows_journal_events`
        const failure = yield* Effect.flip(journal.emitDurable(input(runId("run"), sourceId("s"), "x", 1)))
        expect((failure as JournalError).code).toBe("sink_failed")
      })
    ))

  effect("emitDurable rejects a closed journal", () =>
    Effect.gen(function*() {
      const journal = yield* Effect.scoped(
        Effect.map(
          Layer.build(journalLayer()),
          (context) => Context.get(context, Journal) as Service
        )
      )
      const failure = yield* Effect.flip(journal.emitDurable(input(runId("run"), sourceId("s"), "x", 1)))
      expect((failure as JournalError).code).toBe("journal_closed")
    }))

  effect("the noop journal reports emitDurable as unavailable", () =>
    Effect.gen(function*() {
      const journal = makeNoop()
      const failure = yield* Effect.flip(journal.emitDurable(input(runId("run"), sourceId("s"), "x", 1)))
      expect((failure as JournalError).code).toBe("journal_closed")
    }))
})
