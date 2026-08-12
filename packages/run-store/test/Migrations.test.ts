/**
 * The run store owns `flows_runs` and `flows_attempts` and reserves migration
 * id block 1000 — see `docs/specs/Concepts/Journal Split.md`.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
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

describe("run-store migrations", () => {
  it("migrates a fresh database and reruns idempotently", async () => {
    await migrated(Effect.gen(function*() {
      yield* Migrations.run
      yield* Migrations.run
    }))
  })

  it("creates the run and attempt tables and their indexes", async () => {
    const master = await migrated(Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
    }))

    expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
      "flows_attempts",
      "flows_migrations",
      "flows_runs"
    ])
    const indexes = master.filter((row) => row.type === "index").map((row) => row.name)
    expect(indexes).toContain("flows_runs_parent_run_id_idx")
    expect(indexes).toContain("flows_runs_cancel_requested_idx")
    expect(indexes).toContain("flows_runs_waiting_reason_wake_at_idx")
    expect(indexes).toContain("flows_runs_lineage_idx")
    expect(master.find((row) => row.name === "flows_runs_lineage_idx")?.sql).toContain("UNIQUE INDEX")
    const runsSql = master.find((row) => row.name === "flows_runs")?.sql ?? ""
    const attemptsSql = master.find((row) => row.name === "flows_attempts")?.sql ?? ""
    expect(runsSql).toContain("status IN")
    expect(runsSql).toContain("status = 'running'")
    expect(runsSql).toContain("status <> 'running'")
    expect(attemptsSql).toContain("FOREIGN KEY (run_id) REFERENCES flows_runs (run_id)")
  })

  it("reserves its own migration id block so ids cannot collide", async () => {
    const applied = await Effect.runPromise(Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
    expect(applied).toEqual([[1001, "run-store_initial"], [1002, "run-store_lineage"]])
  })

  it("rejects a half-populated owner tuple", async () => {
    await expect(migrated(Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`INSERT INTO flows_runs (run_id, status, owner_host_id, state_json) VALUES ('run', 'running', 'host', '{}')`
    }))).rejects.toBeDefined()
  })
})
