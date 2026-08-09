/**
 * Journal schema migration runner.
 *
 * Derived contracts: `docs/specs/Concepts/Journal Queue.md`,
 * `docs/specs/Concepts/Run Ownership.md`, and
 * `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import { Database } from "@smthrs/database"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import initial from "./migrations/0001_initial.ts"
import durableEngineState from "./migrations/0002_durable_engine_state.ts"
import runMetadata from "./migrations/0003_run_metadata.ts"
import waitingReason from "./migrations/0004_waiting_reason.ts"

const migrations = {
  "0001_initial": initial,
  "0002_durable_engine_state": durableEngineState,
  "0003_run_metadata": runMetadata,
  "0004_waiting_reason": waitingReason
}

/**
 * Name of a durable journal migration, in ladder order.
 *
 * @category models
 * @since 0.1.0
 */
export type MigrationName = keyof typeof migrations

/**
 * Every migration name, in the order the ladder applies them.
 *
 * @category migrations
 * @since 0.1.0
 */
export const names: ReadonlyArray<MigrationName> = Object.keys(migrations) as ReadonlyArray<MigrationName>

const runRecord = (record: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>) =>
  Effect.gen(function*() {
    const database = yield* Database.Database
    return yield* Migrator.make({})({
      loader: Migrator.fromRecord(record),
      table: "flows_migrations"
    }).pipe(Effect.provideService(SqlClient.SqlClient, database.sql))
  })

/**
 * Runs every pending durable journal migration.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = runRecord(migrations)

/**
 * Runs the ladder up to and including `through`, leaving every later
 * migration pending.
 *
 * A database in the field is always some prefix of the ladder with rows in it,
 * so this is how a test — or an operator staging a rollout — reaches that
 * state: migrate to a prefix, populate, then run the rest. `Migrations.run`
 * alone can only ever apply an `ALTER TABLE` to an empty database, which is
 * exactly the case SQLite never rejects.
 *
 * @category migrations
 * @since 0.1.0
 */
export const runThrough = (through: MigrationName) =>
  runRecord(
    Object.fromEntries(
      Object.entries(migrations).slice(0, names.indexOf(through) + 1)
    )
  )

/**
 * Layer that runs migrations before exposing the database to journal services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
