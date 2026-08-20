/**
 * The journal owns the event table, the checkpoint table, and the
 * `SqlConsensus` lease table. The composed whole-schema assertion — every
 * table every storage package contributes — lives with the composition, in
 * `@smthrs/engine-store`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import consensus from "../src/migrations/0003_consensus.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table"
  readonly sql: string | null
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

describe("journal migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the journal tables and nothing else", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_consensus_leases",
        "flows_journal_checkpoints",
        "flows_journal_events",
        "flows_migrations"
      ])
      expect(master.some((row) => row.name === "flows_journal_events_event_type_idx" && row.type === "index")).toBe(
        true
      )
      const journalSql = master.find((row) => row.name === "flows_journal_events")?.sql ?? ""
      expect(journalSql).toContain("PRIMARY KEY (run_id, seq)")
      expect(journalSql).toContain("UNIQUE (run_id, source_id, source_seq)")
      const checkpointSql = master.find((row) => row.name === "flows_journal_checkpoints")?.sql ?? ""
      expect(checkpointSql).toContain("PRIMARY KEY (run_id, seq)")
      expect(checkpointSql).toContain("compacted_at_ms")
      const leaseSql = master.find((row) => row.name === "flows_consensus_leases")?.sql ?? ""
      expect(leaseSql).toContain("run_id TEXT PRIMARY KEY")
      expect(leaseSql).toContain("granted_at_ms")
      expect(leaseSql).toContain("claimed_at_ms")
    }))

  it.effect("namespaces its migration identity by package", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([[1, "journal_initial"], [2, "journal_checkpoints"], [3, "journal_consensus"]])
    }))

  it.effect("backfills legacy run ownership into consensus leases when flows_runs exists", () =>
    Effect.gen(function*() {
      const rows = yield* Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
          CREATE TABLE flows_runs (
            run_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            owner_host_id TEXT,
            owner_pid INTEGER,
            owner_nonce TEXT,
            heartbeat_at_ms INTEGER,
            claim_host_id TEXT,
            claim_pid INTEGER,
            claim_nonce TEXT,
            claimed_at_ms INTEGER
          )
        `
        yield* sql`
          INSERT INTO flows_runs (
            run_id, status, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms,
            claim_host_id, claim_pid, claim_nonce, claimed_at_ms
          ) VALUES (
            'running-run', 'running', 'host-a', 1, 'owner-a', 10,
            NULL, NULL, NULL, NULL
          ), (
            'claimed-run', 'pending', NULL, NULL, NULL, NULL,
            'host-b', 2, 'claim-b', 20
          ), (
            'mixed-run', 'running', 'host-c', 3, 'owner-c', 30,
            'host-d', 4, 'claim-d', 40
          )
        `
        yield* consensus
        return yield* sql<{
          readonly run_id: string
          readonly owner_host_id: string | null
          readonly heartbeat_at_ms: number | null
          readonly claim_host_id: string | null
          readonly claimed_at_ms: number | null
        }>`
          SELECT run_id, owner_host_id, heartbeat_at_ms, claim_host_id, claimed_at_ms
          FROM flows_consensus_leases
          ORDER BY run_id ASC
        `
      }).pipe(Effect.provide(TestDatabase.layer))

      expect(rows).toEqual([
        {
          run_id: "claimed-run",
          owner_host_id: null,
          heartbeat_at_ms: null,
          claim_host_id: "host-b",
          claimed_at_ms: 20
        },
        {
          run_id: "mixed-run",
          owner_host_id: "host-c",
          heartbeat_at_ms: 30,
          claim_host_id: "host-d",
          claimed_at_ms: 40
        },
        {
          run_id: "running-run",
          owner_host_id: "host-a",
          heartbeat_at_ms: 10,
          claim_host_id: null,
          claimed_at_ms: null
        }
      ])
    }))
})
