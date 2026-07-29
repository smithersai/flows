/**
 * Initial durable journal, run, attempt, and cache schema.
 *
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the initial flows durable schema.
 *
 * @category migrations
 * @since 0.1.0
 */
const initial: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_journal_events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    emitted_at_ms INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    meta_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq),
    UNIQUE (run_id, source_id, source_seq)
  )`

  yield* sql`CREATE INDEX flows_journal_events_event_type_idx ON flows_journal_events (event_type)`

  yield* sql`CREATE TABLE flows_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    owner_host_id TEXT,
    owner_pid INTEGER,
    owner_nonce TEXT,
    heartbeat_at_ms INTEGER,
    claim_host_id TEXT,
    claim_pid INTEGER,
    claim_nonce TEXT,
    claimed_at_ms INTEGER,
    state_json TEXT NOT NULL,
    CHECK (status IN ('pending', 'running', 'suspended', 'completed', 'failed', 'cancelled')),
    CHECK (
      (
        status = 'running' AND
        owner_host_id IS NOT NULL AND
        owner_pid IS NOT NULL AND
        owner_nonce IS NOT NULL AND
        heartbeat_at_ms IS NOT NULL
      ) OR (
        status <> 'running' AND
        owner_host_id IS NULL AND
        owner_pid IS NULL AND
        owner_nonce IS NULL AND
        heartbeat_at_ms IS NULL
      )
    ),
    CHECK (
      (claim_host_id IS NULL AND claim_pid IS NULL AND claim_nonce IS NULL AND claimed_at_ms IS NULL) OR
      (claim_host_id IS NOT NULL AND claim_pid IS NOT NULL AND claim_nonce IS NOT NULL AND claimed_at_ms IS NOT NULL)
    )
  )`

  yield* sql`CREATE TABLE flows_attempts (
    run_id TEXT NOT NULL,
    step_key_digest TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    state TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    heartbeat_at_ms INTEGER,
    checkpoint_json TEXT,
    error_json TEXT,
    outcome_json TEXT,
    meta_json TEXT NOT NULL,
    PRIMARY KEY (run_id, step_key_digest, attempt),
    FOREIGN KEY (run_id) REFERENCES flows_runs (run_id)
  )`

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
