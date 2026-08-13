/**
 * Shared behavioural contract for every `DurableWriter` implementation's `write`.
 *
 * Modeled on `packages/engine-store/test/contract/DurableEngineStateContract.ts`
 * and `packages/kernel/src/test/HostContract.ts`: one suite, run against
 * every implementation, so a new backend cannot land without demonstrating the
 * property its consumers already depend on (issue #97).
 *
 * The property under test is the one `DurableWriter.write` states normatively: two
 * concurrent write transactions are mutually serialized — they may not both
 * commit results computed from snapshots that exclude each other's writes.
 * SQLite gets this from its single-writer transaction lock; a PostgreSQL
 * implementation must run write transactions at `SERIALIZABLE`, and plain
 * READ COMMITTED fails the suite below (both writers read the same row and one
 * update is lost). The engine store's cycle detector inserts an edge and walks
 * the ancestor graph inside one `write`, and its safety argument — "of two
 * edges that jointly close a cycle, exactly the later one fails" — is exactly
 * these tests.
 */
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import type * as DurableWriter from "../../src/DurableWriter.ts"
import { affectedRows } from "../../src/DurableWriter.ts"

/**
 * One connection's client paired with its durable writer.
 */
export interface ContractSide {
  readonly sql: SqlClient.SqlClient
  readonly write: DurableWriter.Service["write"]
}

/**
 * Two client/writer pairs over one shared store. They are separate connections
 * where the implementation has connections; an implementation whose isolation
 * only exists in-process may hand back the same pair twice.
 */
export interface ContractContext {
  readonly a: ContractSide
  readonly b: ContractSide
}

export interface Harness {
  readonly label: string
  /**
   * Set when this harness is known to trip an upstream defect in Effect's
   * `SqlClient.makeWithTransaction`: a failed `BEGIN` (real connections
   * contending for SQLite's write lock, as only a multi-connection harness
   * can produce) still issues `ROLLBACK`, which fails with "cannot rollback
   * - no transaction is active" (issue Effect-TS/effect#7235, fixed
   * upstream by Effect-TS/effect#7236, unreleased). Unmark the affected
   * cases below once flows depends on an effect release containing #7236.
   */
  readonly upstreamRollbackDefect?: boolean
  /** Runs `body` against a freshly created, empty store. */
  readonly run: <A>(body: (context: ContractContext) => Effect.Effect<A, any, never>) => Promise<A>
}

/**
 * Lets both writers reach the point where a non-serialized backend would
 * diverge before either commits, without ever *requiring* that interleaving:
 * an implementation that takes an exclusive lock at `BEGIN` cannot let the
 * second writer read at all, so the wait falls through after a bounded delay
 * and the writers simply run in sequence. Either way the assertions hold; only
 * the non-serialized backend can fail them.
 */
const reachedRead = (
  self: Deferred.Deferred<void>,
  peer: Deferred.Deferred<void>
): Effect.Effect<void> =>
  Deferred.succeed(self, undefined).pipe(
    Effect.andThen(Effect.raceFirst(Deferred.await(peer), Effect.sleep(Duration.millis(250))))
  )

export const describeContract = (harness: Harness): void => {
  describe(`DurableWriter.write contract (${harness.label})`, () => {
    // Expected failure only on a harness flagged `upstreamRollbackDefect`:
    // see the field's doc comment above for the error string, issue, and PR.
    const concurrentIt = harness.upstreamRollbackDefect ? it.fails : it

    concurrentIt("does not lose an update when two writers read-modify-write one row concurrently", async () => {
      const result = await harness.run((context) =>
        Effect.gen(function*() {
          yield* context.a.sql`CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`
          yield* context.a.write(context.a.sql`INSERT INTO counter (id, value) VALUES (1, 0)`)

          const readA = yield* Deferred.make<void>()
          const readB = yield* Deferred.make<void>()
          const increment = (
            database: ContractSide,
            self: Deferred.Deferred<void>,
            peer: Deferred.Deferred<void>
          ) =>
            database.write(
              Effect.gen(function*() {
                const rows = yield* database.sql<{ readonly value: number }>`SELECT value FROM counter WHERE id = 1`
                // Both writers now hold a value read before either committed —
                // the snapshot a lost update is computed from.
                yield* reachedRead(self, peer)
                yield* database.sql`UPDATE counter SET value = ${rows[0]!.value + 1} WHERE id = 1`
              })
            )

          yield* Effect.all(
            [increment(context.a, readA, readB), increment(context.b, readB, readA)],
            { concurrency: "unbounded" }
          )
          const rows = yield* context.a.sql<{ readonly value: number }>`SELECT value FROM counter WHERE id = 1`
          return rows[0]!.value
        })
      )

      // A non-serialized backend commits 1 here: both writers incremented the
      // same pre-race value and one update vanished.
      expect(result).toBe(2)
    })

    concurrentIt("admits exactly one of two writers that each check for absence then insert", async () => {
      const result = await harness.run((context) =>
        Effect.gen(function*() {
          // No unique index: the rule is enforced by the read-then-write
          // decision alone, exactly as the cycle detector's graph walk is.
          yield* context.a.sql`CREATE TABLE edges (id TEXT NOT NULL)`

          const readA = yield* Deferred.make<void>()
          const readB = yield* Deferred.make<void>()
          // The cycle detector's shape in miniature: decide from a read, then
          // write on the strength of that decision, all inside one `write`.
          const claim = (
            database: ContractSide,
            self: Deferred.Deferred<void>,
            peer: Deferred.Deferred<void>
          ) =>
            database.write(
              Effect.gen(function*() {
                const existing = yield* database.sql<{ readonly id: string }>`SELECT id FROM edges WHERE id = 'edge'`
                yield* reachedRead(self, peer)
                if (existing.length > 0) return false
                yield* database.sql`INSERT INTO edges (id) VALUES ('edge')`
                return true
              })
            ).pipe(Effect.catch(() => Effect.succeed(false)))

          const admitted = yield* Effect.all(
            [claim(context.a, readA, readB), claim(context.b, readB, readA)],
            { concurrency: "unbounded" }
          )
          const rows = yield* context.a.sql<{ readonly id: string }>`SELECT id FROM edges`
          return { admitted, rows: rows.length }
        })
      )

      expect(result.admitted.filter((won) => won)).toHaveLength(1)
      expect(result.rows).toBe(1)
    })

    it("makes a committed write visible to a transaction another connection starts afterwards", async () => {
      const seen = await harness.run((context) =>
        Effect.gen(function*() {
          yield* context.a.sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`
          yield* context.a.write(context.a.sql`INSERT INTO notes (id, body) VALUES (1, 'written by a')`)
          return yield* context.b.write(
            context.b.sql<{ readonly body: string }>`SELECT body FROM notes WHERE id = 1`
          )
        })
      )

      expect(seen.map((row) => row.body)).toEqual(["written by a"])
    })

    it("rolls a failed write transaction back whole, leaving no partial effect for a peer to read", async () => {
      const result = await harness.run((context) =>
        Effect.gen(function*() {
          yield* context.a.sql`CREATE TABLE items (id INTEGER PRIMARY KEY)`
          const failure = yield* Effect.flip(
            context.a.write(
              Effect.gen(function*() {
                yield* context.a.sql`INSERT INTO items (id) VALUES (1)`
                yield* context.a.sql`INSERT INTO items (id) VALUES (2)`
                return yield* Effect.fail("abandoned" as const)
              })
            )
          )
          const rows = yield* context.b.sql<{ readonly id: number }>`SELECT id FROM items`
          return { failure, rows: rows.length }
        })
      )

      expect(result.failure).toBe("abandoned")
      expect(result.rows).toBe(0)
    })

    it("reports the affected-row count of a delete that matches a row and of one that matches none", async () => {
      // The cache store's fenced eviction decides "did the compare-and-swap
      // hit?" from this count alone, so it is a backend contract, not a
      // driver detail: a shape whose affected count is unreadable must fail
      // loudly rather than read as zero (issue #134).
      const result = await harness.run((context) =>
        Effect.gen(function*() {
          yield* context.a.sql`CREATE TABLE rows_affected (id INTEGER PRIMARY KEY)`
          yield* context.a.write(context.a.sql`INSERT INTO rows_affected (id) VALUES (1)`)
          const matched = yield* context.a.write(
            context.a.sql`DELETE FROM rows_affected WHERE id = 1`.raw.pipe(Effect.flatMap(affectedRows))
          )
          const unmatched = yield* context.a.write(
            context.a.sql`DELETE FROM rows_affected WHERE id = 1`.raw.pipe(Effect.flatMap(affectedRows))
          )
          return { matched, unmatched }
        })
      )

      expect(result).toEqual({ matched: 1, unmatched: 0 })
    })
  })
}
