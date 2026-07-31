/**
 * Durable deferred completions and absolute clock deadlines.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the durable flow waiting schema.
 *
 * @category migrations
 * @since 0.1.0
 */
const durableEngineState: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_deferred_completions (
    flow_name TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    deferred_name TEXT NOT NULL,
    exit_json TEXT NOT NULL,
    metadata_json TEXT,
    completed_at_ms BIGINT NOT NULL,
    PRIMARY KEY (flow_name, execution_id, deferred_name),
    FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)
  )`

  yield* sql`CREATE TABLE flows_clock_deadlines (
    flow_name TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    clock_name TEXT NOT NULL,
    deferred_name TEXT NOT NULL,
    due_at_ms BIGINT NOT NULL,
    completed_at_ms BIGINT,
    PRIMARY KEY (flow_name, execution_id, clock_name),
    FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)
  )`

  yield* sql`
    CREATE INDEX flows_clock_deadlines_pending_idx
    ON flows_clock_deadlines (completed_at_ms, due_at_ms)
  `
})

export default durableEngineState
