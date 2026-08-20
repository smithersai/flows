/**
 * The step cache owns `flows_step_cache` and `flows_step_cache_recorded` and
 * reserves migration id block 2000 — see
 * `docs/specs/Concepts/Journal Split.md`. Since the fold
 * (`docs/specs/Concepts/Step Cache Fold.md`) the package's `run`/`layer`
 * compose the journal's set first: the `0002_journal_fold` backfill and the
 * SQL store both append to `flows_journal_events`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as Fold from "../src/Fold.ts"
import * as Migrations from "../src/Migrations.ts"
import initial from "../src/migrations/0001_initial.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table"
  readonly sql: string | null
}

interface SnapshotEventRow {
  readonly run_id: string
  readonly seq: number
  readonly event_id: string
  readonly source_id: string
  readonly source_seq: number
  readonly event_type: string
  readonly payload_json: string
  readonly meta_json: string
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

/** The schema as it stood before the fold: both tables, no events behind them. */
const preFold: DatabaseMigrations.MigrationSet = {
  namespace: "step-cache",
  idOffset: DatabaseMigrations.idBlock * 2,
  migrations: { "0001_initial": initial }
}

describe("step-cache migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the head table, the recorded ledger, and the journal prerequisite", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_consensus_leases",
        "flows_journal_checkpoints",
        "flows_journal_events",
        "flows_migrations",
        "flows_step_cache",
        "flows_step_cache_recorded"
      ])
      for (const table of ["flows_step_cache", "flows_step_cache_recorded"]) {
        const cacheSql = master.find((row) => row.name === table)?.sql ?? ""
        expect(cacheSql).toContain("length(key_digest) > 0")
        expect(cacheSql).toContain("json_valid(result_json)")
        expect(cacheSql).toContain("json_valid(meta_json)")
        expect(cacheSql).toContain("typeof(created_at_ms) = 'integer'")
        expect(cacheSql).toContain("length(recorded_run_id) > 0")
        expect(cacheSql).toContain("typeof(recorded_event_seq) = 'integer'")
      }
      const ledgerSql = master.find((row) => row.name === "flows_step_cache_recorded")?.sql ?? ""
      expect(ledgerSql).toContain("PRIMARY KEY (key_digest, recorded_run_id, recorded_event_seq)")
    }))

  it.effect("reserves its own migration id block so ids cannot collide", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([
        [1, "journal_initial"],
        [2, "journal_checkpoints"],
        [3, "journal_consensus"],
        [2001, "step-cache_initial"],
        [2002, "step-cache_journal_fold"]
      ])
    }))

  it.effect("backfills a snapshot event per pre-fold row, under each row's recorded run", () =>
    Effect.gen(function*() {
      const events = yield* Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // A database from before the fold: rows in both tables, one run with
        // pre-existing journal history so the backfill must allocate above
        // its floor, and one head row with no ledger row (a pre-ledger-era
        // entry).
        yield* DatabaseMigrations.run([JournalMigrations.set, preFold])
        yield* sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
          ) VALUES ('run-a', 0, 'existing-0', 'existing', 0, 5, 'flows.engine.run-decision', '{}', 'null')
        `
        yield* sql`
          INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES
            ('digest-a', '{"output":"a"}', '{"source":"a"}', 10, 'run-a', 4),
            ('digest-b', '{"output":"b"}', '{"source":"b"}', 20, 'run-b', 9)
        `
        yield* sql`
          INSERT INTO flows_step_cache_recorded (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ('digest-a', '{"output":"a"}', '{"source":"a"}', 10, 'run-a', 4)
        `
        // The fold migration is the only pending one on this database.
        yield* Migrations.run
        return yield* sql<SnapshotEventRow>`
          SELECT run_id, seq, event_id, source_id, source_seq, event_type, payload_json, meta_json
          FROM flows_journal_events
          WHERE event_type = 'flows.cache.snapshot'
          ORDER BY run_id, seq
        `
      }).pipe(Effect.provide(TestDatabase.layer))

      expect(events).toHaveLength(3)
      const [headA, ledgerA, headB] = events as [SnapshotEventRow, SnapshotEventRow, SnapshotEventRow]
      // run-a already held sequence 0, so its snapshots allocate 1 and 2;
      // run-b starts fresh at 0.
      expect([headA.run_id, headA.seq]).toEqual(["run-a", 1])
      expect([ledgerA.run_id, ledgerA.seq]).toEqual(["run-a", 2])
      expect([headB.run_id, headB.seq]).toEqual(["run-b", 0])
      expect(headA.source_id.endsWith(":snapshot:head")).toBe(true)
      expect(ledgerA.source_id.endsWith(":snapshot:recorded")).toBe(true)
      expect(headA.event_id).toBe(`flows:event:5:run-a${headA.source_id.length}:${headA.source_id}0`)
      expect(JSON.parse(headA.payload_json)).toEqual({
        table: "head",
        keyDigest: "digest-a",
        result: { output: "a" },
        meta: { source: "a" },
        createdAtMs: 10,
        recordedRunId: "run-a",
        recordedEventSeq: 4
      })
      expect(JSON.parse(ledgerA.payload_json)).toEqual({
        table: "recorded",
        keyDigest: "digest-a",
        result: { output: "a" },
        meta: { source: "a" },
        createdAtMs: 10,
        recordedRunId: "run-a",
        recordedEventSeq: 4
      })
      expect(JSON.parse(headB.meta_json)).toEqual({ lineageId: "run-b/root" })
    }))

  it.effect("a pre-fold database survives migrate, drop, and rebuild with equivalent state", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const tables = Effect.gen(function*() {
          const head = yield* sql<Record<string, unknown>>`
            SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            FROM flows_step_cache ORDER BY key_digest
          `
          const ledger = yield* sql<Record<string, unknown>>`
            SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            FROM flows_step_cache_recorded ORDER BY key_digest, recorded_run_id, recorded_event_seq
          `
          return { head, ledger }
        })
        yield* DatabaseMigrations.run([JournalMigrations.set, preFold])
        yield* sql`
          INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES
            ('digest-a', '{"output":"a"}', '{"source":"a"}', 10, 'run-a', 4),
            ('digest-b', '{"output":"b"}', '{"source":"b"}', 20, 'run-b', 9)
        `
        yield* sql`
          INSERT INTO flows_step_cache_recorded (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ('digest-a', '{"output":"a"}', '{"source":"a"}', 10, 'run-a', 4)
        `
        yield* Migrations.run
        const before = yield* tables
        const rebuilt = yield* Fold.rebuild
        expect(rebuilt).toEqual({ entries: 3, head: 2, ledger: 1 })
        expect(yield* tables).toEqual(before)

        // The snapshot-asserted rows are live rows: a post-fold eviction of
        // one journals, and a second rebuild keeps it gone. The migrator runs
        // its migrations on the live wall clock (its lock-retry backoff must
        // outlive a virtualized test clock), so the test clock is advanced
        // past it before the store stamps the eviction — in production both
        // paths share the live clock and are monotonic by construction.
        yield* TestClock.adjust("10000 weeks")
        yield* Effect.gen(function*() {
          const store = yield* CacheStore
          expect(yield* store.evict("digest-a")).toBe(true)
        }).pipe(
          Effect.provide(CacheStoreLive.layer.pipe(
            Layer.provide(SqlJournal.layer({ capacity: 64, overflow: "reject" }))
          )),
          Effect.scoped
        )
        const evicted = yield* tables
        expect(evicted.head.map((row) => row.key_digest)).toEqual(["digest-b"])
        yield* Fold.rebuild
        expect(yield* tables).toEqual(evicted)
      }).pipe(Effect.provide(TestDatabase.layer))
    }))

  it.effect("enforces every cache row invariant at the schema boundary", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const invalidRows = [
          "('', '{}', '{}', 0, 'run', 0)",
          "('bad-result', 'not-json', '{}', 0, 'run', 0)",
          "('bad-meta', '{}', 'not-json', 0, 'run', 0)",
          "('negative-created', '{}', '{}', -1, 'run', 0)",
          "('fractional-created', '{}', '{}', 0.5, 'run', 0)",
          "('unsafe-created', '{}', '{}', 9007199254740992, 'run', 0)",
          "('empty-run', '{}', '{}', 0, '', 0)",
          "('negative-seq', '{}', '{}', 0, 'run', -1)",
          "('fractional-seq', '{}', '{}', 0, 'run', 0.5)",
          "('unsafe-seq', '{}', '{}', 0, 'run', 9007199254740992)"
        ] as const
        return yield* Effect.forEach(invalidRows, (values) =>
          Effect.exit(sql.unsafe(
            `INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ${values}`
          )))
      }))

      expect(outcomes.every(Exit.isFailure)).toBe(true)
    }))
})
