/**
 * Initial durable step result cache schema.
 *
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_step_cache` table.
 *
 * @category migrations
 * @since 0.1.0
 */
const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_step_cache (
    key_digest TEXT PRIMARY KEY CHECK (length(key_digest) > 0),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    created_at_ms INTEGER NOT NULL CHECK (
      typeof(created_at_ms) = 'integer' AND
      created_at_ms >= 0 AND
      created_at_ms <= 9007199254740991
    ),
    recorded_run_id TEXT NOT NULL CHECK (length(recorded_run_id) > 0),
    recorded_event_seq INTEGER NOT NULL CHECK (
      typeof(recorded_event_seq) = 'integer' AND
      recorded_event_seq >= 0 AND
      recorded_event_seq <= 9007199254740991
    )
  )`
})

export default initial
