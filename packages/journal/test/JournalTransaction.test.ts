/**
 * Pins the WAL/state atomicity seam: `Journal.transact` runs a state
 * projection and the lifecycle entries describing it in ONE write
 * transaction, and publishes those entries only once that transaction has
 * committed.
 *
 * Prior art: `reference/temporal/service/history/workflow/transaction_impl.go`
 * submits the mutable-state mutation and its event batches as one persistence
 * request.
 */
import { Database } from "@smithers/database/Database"
import * as TestDatabase from "@smithers/database/test/TestDatabase"
import { Effect, Layer, PubSub } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Journal, JournalError, makeNoop } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: 0 as SourceSeq,
    eventType,
    payload
  }, { disableChecks: true })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.merge(RunStore.layer),
  Layer.provideMerge(migratedDatabase)
)

const withStack = <A, E>(body: Effect.Effect<A, E, Journal | Database | RunStore.RunStore | Scope.Scope>) =>
  Effect.scoped(body.pipe(Effect.provide(stack)))

const rowsOf = (database: Database["Service"], run: RunId) =>
  database.sql<{ readonly seq: number; readonly event_type: string }>`
    SELECT seq, event_type FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `

class Rejected extends Error {
  override readonly name = "Rejected"
}

describe("Journal.transact", () => {
  effect(
    "commits a lifecycle entry and the state projection it describes together",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const runs = yield* RunStore.RunStore
        const database = yield* Database
        const run = runId("atomic-commit")

        yield* journal.transact(Effect.gen(function*() {
          yield* runs.create(run, "{}")
          yield* journal.emitDurable(
            input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" })
          )
        }))

        const row = yield* runs.get(run)
        const rows = yield* rowsOf(database, run)
        expect(row.status).toBe("pending")
        expect(rows.map((entry) => entry.event_type)).toEqual(["flows.engine.run-decision"])
      }))
  )

  effect("rolls the lifecycle entry back with the state write it describes", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const database = yield* Database
      const run = runId("atomic-rollback")

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* runs.create(run, "{}")
        yield* journal.emitDurable(input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" }))
        return yield* Effect.fail(new Rejected("state transition rejected after the WAL append"))
      })).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      const missing = yield* runs.get(run).pipe(Effect.flip)
      const rows = yield* rowsOf(database, run)
      // Journal/state equivalence: neither half of the pair survives.
      expect(missing.code).toBe("not_found_row")
      expect(rows).toHaveLength(0)
    })))

  effect("leaves a rolled-back producer identity re-emittable", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const database = yield* Database
      const run = runId("atomic-reemit")
      const record = () => input(run, sourceId("driver"), "flows.engine.attempt-finished", { state: "succeeded" })

      yield* journal.transact(
        journal.emitDurable(record()).pipe(
          Effect.andThen(Effect.fail(new Rejected("rolled back")))
        )
      ).pipe(Effect.exit)

      // The in-process source index must not vouch for the rolled-back write:
      // a retry has to reach SQL again, not collapse into a phantom Duplicate.
      const receipt = yield* journal.emitDurable(record())
      const rows = yield* rowsOf(database, run)
      expect(receipt._tag).toBe("Accepted")
      expect(rows.map((entry) => entry.seq)).toEqual([receipt.seq])
    })))

  effect(
    "publishes committed entries to subscribers only after the transaction commits",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const run = runId("atomic-publish")
        const subscription = yield* journal.changes

        const pendingInside = yield* journal.transact(Effect.gen(function*() {
          yield* journal.emitDurable(input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "a" }))
          return yield* PubSub.remaining(subscription)
        }))

        expect(pendingInside).toBe(0)
        expect(yield* PubSub.remaining(subscription)).toBe(1)
      }))
  )

  effect("settles a nested transaction once, at the outermost commit", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const database = yield* Database
      const run = runId("atomic-nested")
      const subscription = yield* journal.changes

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* runs.create(run, "{}")
        yield* journal.transact(
          journal.emitDurable(input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "nested" }))
        )
        return yield* Effect.fail(new Rejected("outer rejected after the inner append"))
      })).pipe(Effect.exit)

      // The inner transaction is a savepoint of the outer one, so the outer
      // rollback takes the inner append with it — and nothing was published.
      expect(exit._tag).toBe("Failure")
      expect(yield* PubSub.remaining(subscription)).toBe(0)
      expect(yield* rowsOf(database, run)).toHaveLength(0)
    })))

  effect("reports a storage failure as a journal error", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const database = yield* Database
      const failure = yield* journal.transact(
        database.sql`SELECT 1 FROM flows_no_such_table`
      ).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("sink_failed")
    })))

  effect("the closed stub runs the effect directly", () =>
    Effect.gen(function*() {
      const closed = makeNoop()
      expect(yield* closed.transact(Effect.succeed(7))).toBe(7)
    }))
})
