/**
 * The journal write counters: durable and lossy emission receipts land in the
 * registry the caller provided, keyed by channel and receipt.
 */
import type { DurableWriter } from "@smthrs/database-next/DurableWriter"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import { Effect, Layer, Metric } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as JournalMetrics from "../src/JournalMetrics.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const input = (sequence: number, payload: unknown = { n: 1 }): Input =>
  new Input({
    runId: runId("run-metrics"),
    sourceId: sourceId("source-metrics"),
    sourceSeq: sourceSeq(sequence),
    eventType: "counted",
    payload
  }, { disableChecks: true })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const journalLayer = (overrides: Partial<SqlJournal.SqlJournalOptions> = {}) =>
  SqlJournal.layer({ capacity: 8, overflow: "reject", ...overrides }).pipe(Layer.provideMerge(migratedDatabase))

const withJournal = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient>,
  overrides: Partial<SqlJournal.SqlJournalOptions> = {}
) =>
  Effect.runPromise(
    Effect.scoped(body.pipe(Effect.provide(journalLayer(overrides)))).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

describe("JournalMetrics", () => {
  it("counts durable and lossy receipts through the provided registry", async () => {
    await withJournal(Effect.gen(function*() {
      const journal = yield* Journal

      expect((yield* journal.emitDurable(input(0)))._tag).toBe("Accepted")
      expect((yield* journal.emitDurable(input(0)))._tag).toBe("Duplicate")
      expect((yield* journal.emitLossy(input(1)))._tag).toBe("Accepted")
      expect((yield* journal.emitLossy(input(1)))._tag).toBe("Duplicate")
      yield* journal.flush

      expect(yield* count(JournalMetrics.durable.Accepted)).toBe(1)
      expect(yield* count(JournalMetrics.durable.Duplicate)).toBe(1)
      expect(yield* count(JournalMetrics.lossy.Accepted)).toBe(1)
      expect(yield* count(JournalMetrics.lossy.Duplicate)).toBe(1)
      // A dropped receipt lands in the same table; `Journal.test.ts` proves
      // the drop policies themselves.
      expect(yield* count(JournalMetrics.lossy.Dropped)).toBe(0)
    }))
  })
})
