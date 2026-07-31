/**
 * Journal schema migration runner.
 *
 * Derived contracts: `docs/specs/Concepts/Journal Queue.md`,
 * `docs/specs/Concepts/Run Ownership.md`, and
 * `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import { Database } from "@smithers/database"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import initial from "./migrations/0001_initial.ts"
import durableEngineState from "./migrations/0002_durable_engine_state.ts"

const migrations = {
  "0001_initial": initial,
  "0002_durable_engine_state": durableEngineState
}

/**
 * Runs every pending durable journal migration.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = Effect.gen(function*() {
  const database = yield* Database.Database
  return yield* Migrator.make({})({
    loader: Migrator.fromRecord(migrations),
    table: "flows_migrations"
  }).pipe(Effect.provideService(SqlClient.SqlClient, database.sql))
})

/**
 * Layer that runs migrations before exposing the database to journal services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
