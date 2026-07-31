/**
 * First-class run metadata columns that participate in SQL guards and queries.
 *
 * Only metadata a compare-and-swap or a scan needs lives in a column. Anything
 * else a harness carries stays in `state_json`, which the run reference
 * documents as the extension point.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md` (guarded
 * transitions and `cancel_requested_at_ms`) and
 * `docs/specs/Concepts/Time Travel.md` (`parent_run_id` lineage).
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds lineage and cancellation-request columns to `flows_runs`.
 *
 * @category migrations
 * @since 0.1.0
 */
const runMetadata: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE flows_runs ADD COLUMN parent_run_id TEXT`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN cancel_requested_at_ms INTEGER`

  yield* sql`CREATE INDEX flows_runs_parent_run_id_idx ON flows_runs (parent_run_id)`
  yield* sql`
    CREATE INDEX flows_runs_cancel_requested_idx
    ON flows_runs (cancel_requested_at_ms)
    WHERE cancel_requested_at_ms IS NOT NULL
  `
})

export default runMetadata
