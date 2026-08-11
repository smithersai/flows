/**
 * The journal's durable channel accepts an `OwnerId` and fences the append on
 * it: the INSERT only lands while `flows_runs` still records that owner as the
 * running run's owner, and otherwise the append fails `fence_lost` rather than
 * writing behind a live successor.
 *
 * `flows_runs` belongs to `@smthrs/run-store`, which depends on this package
 * and so cannot be depended on from here. This suite therefore stands up the
 * *columns the fence reads* as a fixture, which is exactly the contract the
 * journal asserts on a table it does not own. `@smthrs/engine-store` — which
 * composes both — pins the same behaviour against the real migrated schema in
 * its `JournalFencing` suite.
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

const input = (run: RunId, source: SourceId, sourceSeq: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sourceSeq as SourceSeq,
    eventType: "flows.engine.run-decision",
    payload: { decision: "created" }
  }, { disableChecks: true })

/** The `flows_runs` columns the fenced append's `WHERE EXISTS` reads. */
const fenceTable = Layer.effectDiscard(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    owner_host_id TEXT,
    owner_pid INTEGER,
    owner_nonce TEXT
  )`
}))

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.provideMerge(
    Layer.provideMerge(Layer.provideMerge(fenceTable, Migrations.layer), TestDatabase.layer)
  )
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient | Scope.Scope>
) => Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(stack), Effect.provide(TestClock.layer()))))

const claim = (sql: SqlClient.SqlClient, run: RunId, holder: OwnerId) =>
  sql`INSERT INTO flows_runs (run_id, status, owner_host_id, owner_pid, owner_nonce)
      VALUES (${run}, 'running', ${holder.hostId}, ${holder.pid}, ${holder.nonce})`

describe("SqlJournal durable fencing", () => {
  it("commits a fenced append while the supplied owner still holds the run", async () => {
    const receipt = await withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("fenced-commit")
      yield* claim(sql, run, owner)
      return yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
    }))

    expect(receipt._tag).toBe("Accepted")
  })

  it("fails the append with fence_lost once the run has a different owner", async () => {
    const failure = await withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("fenced-lost")
      yield* claim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
      return yield* Effect.flip(journal.emitDurable(input(run, sourceId("driver"), 0), owner))
    }))

    expect(failure).toBeInstanceOf(JournalError)
    expect((failure as JournalError).code).toBe("fence_lost")
  })

  it("stays idempotent when a fenced retry re-emits an already-committed entry", async () => {
    const receipts = await withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("fenced-retry")
      yield* claim(sql, run, owner)
      const first = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
      const second = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
      return [first, second] as const
    }))

    expect(receipts[0]._tag).toBe("Accepted")
    expect(receipts[1]._tag).toBe("Duplicate")
  })
})
