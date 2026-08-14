/**
 * Pins the namespacing contract of the composed migrator: two storage packages
 * that both ship an `0001_initial` must migrate to distinct identities, and a
 * package that mis-declares its namespace or id block must fail the migration
 * loudly rather than silently shadow its neighbour's table.
 *
 * Derived contract: `docs/specs/Concepts/Journal Split.md`.
 */
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"

const createTable = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`)
  })

const alpha: Migrations.MigrationSet = {
  namespace: "alpha",
  idOffset: 0,
  migrations: { "0001_initial": createTable("alpha_rows") }
}

const beta: Migrations.MigrationSet = {
  namespace: "beta",
  idOffset: Migrations.idBlock,
  migrations: { "0001_initial": createTable("beta_rows") }
}

const provided = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(TestDatabase.layer))))

const failureMessage = async <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => {
  const exit = await provided(effect)
  if (exit._tag !== "Failure") throw new Error("expected the migration to fail")
  return JSON.stringify(exit.cause)
}

describe("composed migrations", () => {
  // BUG: rejectSkipped treats zero as already below the fresh database's high-water mark.
  it.fails("applies migration id zero on a fresh database", async () => {
    const zero: Migrations.MigrationSet = {
      namespace: "zero",
      idOffset: 0,
      migrations: { "0000_initial": createTable("zero_rows") }
    }
    const exit = await provided(Migrations.run([zero]))

    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : []).toEqual([[0, "zero_initial"]])
  })

  it("lifts each package's local ids into the block it reserves", async () => {
    const exit = await provided(Migrations.run([alpha, beta]))
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : []).toEqual([
      [1, "alpha_initial"],
      [1001, "beta_initial"]
    ])
  })

  it("runs migrations in id order however the sets are supplied", async () => {
    const exit = await provided(Migrations.run([beta, alpha]))
    expect(exit._tag === "Success" ? exit.value : []).toEqual([
      [1, "alpha_initial"],
      [1001, "beta_initial"]
    ])
  })

  it("installs every set's tables through the layer", async () => {
    const exit = await provided(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<
          { readonly name: string }
        >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      }).pipe(Effect.provide(Migrations.layer([alpha, beta])))
    )
    expect(exit._tag === "Success" ? exit.value.map((row) => row.name) : []).toEqual([
      "alpha_rows",
      "beta_rows",
      Migrations.table
    ].sort())
  })

  it("rejects a duplicate namespace", async () => {
    expect(await failureMessage(Migrations.run([alpha, { ...beta, namespace: "alpha" }])))
      .toContain("Duplicate migration namespace: alpha")
  })

  it("rejects a duplicate id offset", async () => {
    expect(await failureMessage(Migrations.run([alpha, { ...beta, idOffset: 0 }])))
      .toContain("Duplicate migration id offset 0 for namespace beta")
  })

  it("rejects an id collision the offsets failed to prevent", async () => {
    const overlapping: Migrations.MigrationSet = {
      namespace: "gamma",
      idOffset: 1,
      migrations: { "1000_initial": createTable("gamma_rows") }
    }
    expect(await failureMessage(Migrations.run([beta, overlapping])))
      .toContain("Migration id 1001 claimed by both beta and gamma")
  })

  it("rejects a set the migrator's high-water mark would silently skip", async () => {
    // `Migrator` runs only ids above the highest applied one, so migrating the
    // 1000 block first leaves `alpha`'s id 1 looking done. Failing here is the
    // whole point: the alternative is a missing table and a passing migration.
    const message = await failureMessage(Effect.flatMap(
      Migrations.run([beta]),
      () => Migrations.run([alpha, beta])
    ))
    expect(message).toContain("Migration 1_alpha_initial would be skipped")
    expect(message).toContain("already applied migration id 1001")
  })

  it("accepts a set every id of which is already applied", async () => {
    const exit = await provided(Effect.flatMap(
      Migrations.run([alpha, beta]),
      () => Migrations.run([alpha])
    ))
    expect(exit._tag === "Success" ? exit.value : "failed").toEqual([])
  })

  it("rolls back partial DDL and migration records when a later migration fails", async () => {
    const broken: Migrations.MigrationSet = {
      namespace: "rerun",
      idOffset: 0,
      migrations: {
        "0001_first": createTable("rerun_first"),
        "0002_second": Effect.fail("second migration failed")
      }
    }
    const corrected: Migrations.MigrationSet = {
      ...broken,
      migrations: {
        "0001_first": createTable("rerun_first"),
        "0002_second": createTable("rerun_second")
      }
    }

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const failed = yield* Effect.exit(Migrations.run([broken]))
        const tablesAfterFailure = yield* sql<
          { readonly name: string }
        >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
        const recordsAfterFailure = yield* sql<
          { readonly migration_id: number }
        >`SELECT migration_id FROM ${sql(Migrations.table)} ORDER BY migration_id`
        const completed = yield* Migrations.run([corrected])
        const tablesAfterRerun = yield* sql<
          { readonly name: string }
        >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
        return { completed, failed, recordsAfterFailure, tablesAfterFailure, tablesAfterRerun }
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(Exit.isFailure(result.failed)).toBe(true)
    if (Exit.isFailure(result.failed)) {
      const defect = Cause.findDefect(result.failed.cause)
      expect(Result.isSuccess(defect)).toBe(true)
      if (Result.isSuccess(defect)) {
        expect(defect.success).toBeInstanceOf(Migrator.MigrationError)
        expect(defect.success).toMatchObject({ kind: "Failed" })
      }
    }
    expect(result.tablesAfterFailure.map((row) => row.name)).toEqual([Migrations.table])
    expect(result.recordsAfterFailure).toEqual([])
    expect(result.completed).toEqual([
      [1, "rerun_first"],
      [2, "rerun_second"]
    ])
    expect(result.tablesAfterRerun.map((row) => row.name)).toEqual([
      Migrations.table,
      "rerun_first",
      "rerun_second"
    ].sort())
  })

  it("accepts an empty array of migration sets", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const completed = yield* Migrations.run([])
        const tables = yield* sql<
          { readonly name: string }
        >`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
        return { completed, tables }
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(result.completed).toEqual([])
    expect(result.tables.map((row) => row.name)).toEqual([Migrations.table])
  })

  it("accepts a migration set with no migrations", async () => {
    const empty: Migrations.MigrationSet = {
      namespace: "empty",
      idOffset: 0,
      migrations: {}
    }
    const exit = await provided(Migrations.run([empty]))

    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : "failed").toEqual([])
  })

  // BUG: loader accepts a negative offset when its resulting migration id remains positive.
  it.fails("rejects a negative idOffset as bad migration state", async () => {
    const invalid: Migrations.MigrationSet = {
      namespace: "negative",
      idOffset: -1,
      migrations: { "1000_initial": createTable("negative_rows") }
    }
    const exit = await provided(Migrations.run([invalid]))
    const failure = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findError(exit.cause)) : undefined

    expect(failure).toBeInstanceOf(Migrator.MigrationError)
    expect(failure).toMatchObject({ kind: "BadState" })
  })

  // BUG: loader forwards a fractional migration id to SQLite instead of rejecting the invalid offset itself.
  it.fails("rejects a non-integer idOffset as bad migration state", async () => {
    const invalid: Migrations.MigrationSet = {
      namespace: "fractional",
      idOffset: 0.5,
      migrations: { "0001_initial": createTable("fractional_rows") }
    }
    const exit = await provided(Migrations.run([invalid]))
    const failure = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findError(exit.cause)) : undefined

    expect(failure).toBeInstanceOf(Migrator.MigrationError)
    expect(failure).toMatchObject({ kind: "BadState" })
  })

  it("reports a migrations table it cannot read", async () => {
    expect(await failureMessage(Migrations.loader([alpha])))
      .toContain(`Could not read ${Migrations.table}`)
  })

  it("rejects a malformed migration key", async () => {
    const malformed: Migrations.MigrationSet = {
      namespace: "delta",
      idOffset: 0,
      migrations: { initial: createTable("delta_rows") }
    }
    expect(await failureMessage(Migrations.run([malformed])))
      .toContain("Malformed migration key")
  })
})
