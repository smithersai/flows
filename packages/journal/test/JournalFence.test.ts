/**
 * The journal's durable channel accepts an `OwnerId` and fences the append on
 * it through the injected `Consensus` strategy: the INSERT only lands while
 * the strategy still records that owner as holding the run, and otherwise the
 * append fails `fence_lost` rather than writing behind a live successor.
 *
 * The strategy here is the default `SqlConsensus`, whose lease table this
 * package owns and migrates, so the suite drives ownership through the real
 * strategy operations. `@smthrs/engine-store`'s `JournalFencing` suite pins
 * the same behaviour against the fully composed engine schema.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Consensus } from "../src/Consensus.ts"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlConsensus from "../src/SqlConsensus.ts"
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

const stack = SqlJournal.layerWith({ capacity: 8, overflow: "reject" }).pipe(
  Layer.provideMerge(SqlConsensus.layer),
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | Consensus | DurableWriter | SqlClient.SqlClient | Scope.Scope>
) => Effect.scoped(body.pipe(Effect.provide(stack), Effect.provide(TestClock.layer())))

const own = (run: RunId, holder: OwnerId) =>
  Effect.gen(function*() {
    const consensus = yield* Consensus
    const grant = yield* consensus.claim(run, holder, 0)
    expect(grant._tag).toBe("Claimed")
    const activation = yield* consensus.activate(run, holder, 0, 0)
    expect(activation._tag).toBe("Activated")
  })

describe("SqlJournal durable fencing", () => {
  it.effect("commits a fenced append while the supplied owner still holds the run", () =>
    Effect.gen(function*() {
      const receipt = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const run = runId("fenced-commit")
        yield* own(run, owner)
        return yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
      }))

      expect(receipt._tag).toBe("Accepted")
    }))

  it.effect("fails the append with fence_lost once the run has a different owner", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const run = runId("fenced-lost")
        yield* own(run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.emitDurable(input(run, sourceId("driver"), 0), owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))

  it.effect("treats a malformed owner as a lost fence rather than a driver failure", () =>
    Effect.gen(function*() {
      // `OwnerId` is `Schema.String`/`Schema.Number` with no runtime refinement,
      // so a caller can hand the fence an empty identifier or a non-integral pid.
      // The strategy guard is an equality comparison, so none of these can match
      // the recorded lease — the contract being pinned is that each is reported
      // as the typed `fence_lost` a zombie owner gets, never a raw SQL/driver
      // error and never a silent append behind the live owner.
      const malformed: ReadonlyArray<OwnerId> = [
        { hostId: "", pid: 42, nonce: "nonce-a" },
        { hostId: "host-a", pid: 42, nonce: "" },
        { hostId: "host-a", pid: 42.5, nonce: "nonce-a" },
        { hostId: "host-a", pid: Number.NaN, nonce: "nonce-a" },
        { hostId: "host-a", pid: Number.POSITIVE_INFINITY, nonce: "nonce-a" }
      ]

      const result = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-malformed")
        yield* own(run, owner)
        const failures = yield* Effect.forEach(
          malformed,
          (holder, index) => Effect.flip(journal.emitDurable(input(run, sourceId("driver"), index), holder))
        )
        const rows = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM flows_journal_events WHERE run_id = ${run}
      `
        return { failures, total: Number(rows[0]!.total) }
      }))

      for (const failure of result.failures) {
        expect(failure).toBeInstanceOf(JournalError)
        expect((failure as JournalError).code).toBe("fence_lost")
      }
      // The legitimate owner's run gains no rows from any of them.
      expect(result.total).toBe(0)
    }))

  it.effect("stays idempotent when a fenced retry re-emits an already-committed entry", () =>
    Effect.gen(function*() {
      const receipts = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const run = runId("fenced-retry")
        yield* own(run, owner)
        const first = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        const second = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        return [first, second] as const
      }))

      expect(receipts[0]._tag).toBe("Accepted")
      expect(receipts[1]._tag).toBe("Duplicate")
    }))

  it.effect("wraps a strategy persistence failure as sink_failed, never as a lost fence", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-broken-strategy")
        yield* own(run, owner)
        // Destroying the lease table makes the guard's read fail; the append
        // must report the storage failure rather than telling a live owner it
        // lost the run.
        yield* sql`DROP TABLE flows_consensus_leases`
        return yield* Effect.flip(journal.emitDurable(input(run, sourceId("driver"), 0), owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("sink_failed")
    }))
})
