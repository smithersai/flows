import * as DurableWriter from "@smthrs/database-next/DurableWriter"
import * as NodeDatabase from "@smthrs/database-next/node/NodeDatabase"
import * as EngineMigrations from "@smthrs/engine-store-next/Migrations"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const database = (filename: string) => Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))

const withDatabase = <A>(
  filename: string,
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient | DurableWriter.DurableWriter>
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(database(filename)))))

describe("time-travel migrations", () => {
  it("widens a legacy snapshots table that predates plan_digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-time-travel-legacy-"))
    const filename = join(directory, "legacy.sqlite")
    try {
      const columns = await withDatabase(
        filename,
        Effect.gen(function*() {
          yield* EngineMigrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`
            CREATE TABLE flows_time_travel_snapshots (
              run_id TEXT NOT NULL,
              lineage_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              change_id TEXT NOT NULL,
              PRIMARY KEY (run_id, lineage_id, seq)
            )
          `
          yield* SqlTimeTravelStore.migrate
          return yield* sql<{ readonly name: string }>`PRAGMA table_info(flows_time_travel_snapshots)`
        })
      )

      expect(columns.map((column) => column.name)).toContain("plan_digest")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("applies the full ladder repeatedly across persistent database lifetimes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-time-travel-migrations-"))
    const filename = join(directory, "migrations.sqlite")
    try {
      await withDatabase(filename, Migrations.run.pipe(Effect.andThen(Migrations.run)))
      const rows = await withDatabase(
        filename,
        Migrations.run.pipe(
          Effect.andThen(Effect.service(SqlClient.SqlClient)),
          Effect.flatMap((sql) =>
            sql<{ readonly migration_id: number }>`
              SELECT migration_id FROM flows_migrations
              WHERE migration_id = 5001
            `
          )
        )
      )

      expect(rows).toEqual([{ migration_id: 5001 }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  // BUG: migrate ignores every ALTER TABLE failure, not only SQLite's duplicate-column error.
  it.fails("surfaces a non-duplicate ALTER TABLE failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-time-travel-alter-"))
    const filename = join(directory, "alter.sqlite")
    try {
      const exit = await withDatabase(
        filename,
        Effect.gen(function*() {
          yield* EngineMigrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`CREATE VIEW flows_time_travel_snapshots AS SELECT 1 AS run_id`
          return yield* Effect.exit(SqlTimeTravelStore.migrate)
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
