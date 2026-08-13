/**
 * The journal owns exactly one table family. The composed whole-schema
 * assertion — every table every storage package contributes — lives with the
 * composition, in `@smthrs/engine-store-next`.
 */
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table"
  readonly sql: string | null
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer)))

describe("journal migrations", () => {
  it("migrates a fresh database and reruns idempotently", async () => {
    await migrated(Effect.gen(function*() {
      yield* Migrations.run
      yield* Migrations.run
    }))
  })

  it("creates the journal tables and nothing else", async () => {
    const master = await migrated(Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
    }))

    expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
      "flows_journal_checkpoints",
      "flows_journal_events",
      "flows_migrations"
    ])
    expect(master.some((row) => row.name === "flows_journal_events_event_type_idx" && row.type === "index")).toBe(true)
    const journalSql = master.find((row) => row.name === "flows_journal_events")?.sql ?? ""
    expect(journalSql).toContain("PRIMARY KEY (run_id, seq)")
    expect(journalSql).toContain("UNIQUE (run_id, source_id, source_seq)")
    const checkpointSql = master.find((row) => row.name === "flows_journal_checkpoints")?.sql ?? ""
    expect(checkpointSql).toContain("PRIMARY KEY (run_id, seq)")
    expect(checkpointSql).toContain("compacted_at_ms")
  })

  it("namespaces its migration identity by package", async () => {
    const applied = await Effect.runPromise(Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
    expect(applied).toEqual([[1, "journal_initial"], [2, "journal_checkpoints"]])
  })
})
