/**
 * Journal schema migration runner.
 *
 * Derived contracts: `docs/specs/Concepts/Journal Queue.md`,
 * `docs/specs/Concepts/Run Ownership.md`, and
 * `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import initial from "./migrations/0001_initial.ts"

/** @private */
const migrations = {
  "0001_initial": initial
}
/** Creates the journal's authoritative durable schema. @category migrations @since 0.1.0 */
export const run = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "flows_migrations"
})

/**
 * Layer that runs migrations before exposing the database to journal services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
