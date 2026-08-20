/**
 * The `SqlConsensus` lease table.
 *
 * This is the private schema of the default consensus strategy: the owner
 * tuple, the two-phase claim columns, and the grant timestamp relocated from
 * `flows_runs` (`docs/specs/Concepts/Journal Consensus.md`). Lease rows are
 * strategy evidence, never history — ownership transitions reach the journal
 * as events (rule R6), heartbeats never do.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_consensus_leases` table and backfills any pre-consensus
 * run ownership rows when `flows_runs` is already present in the database.
 *
 * @category migrations
 * @since 0.1.0
 */
const consensus: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE flows_consensus_leases (
    run_id TEXT PRIMARY KEY CHECK (length(run_id) > 0),
    owner_host_id TEXT,
    owner_pid INTEGER CHECK (owner_pid IS NULL OR typeof(owner_pid) = 'integer'),
    owner_nonce TEXT,
    granted_at_ms INTEGER CHECK (granted_at_ms IS NULL OR (typeof(granted_at_ms) = 'integer' AND granted_at_ms >= 0)),
    heartbeat_at_ms INTEGER CHECK (heartbeat_at_ms IS NULL OR (typeof(heartbeat_at_ms) = 'integer' AND heartbeat_at_ms >= 0)),
    claim_host_id TEXT,
    claim_pid INTEGER CHECK (claim_pid IS NULL OR typeof(claim_pid) = 'integer'),
    claim_nonce TEXT,
    claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR (typeof(claimed_at_ms) = 'integer' AND claimed_at_ms >= 0))
  )`

  const legacyRuns = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'flows_runs'
  `
  if (legacyRuns.length === 0) {
    return
  }

  yield* sql`
    INSERT INTO flows_consensus_leases (
      run_id,
      owner_host_id,
      owner_pid,
      owner_nonce,
      granted_at_ms,
      heartbeat_at_ms,
      claim_host_id,
      claim_pid,
      claim_nonce,
      claimed_at_ms
    )
    SELECT
      run_id,
      owner_host_id,
      owner_pid,
      owner_nonce,
      CASE
        WHEN status = 'running' THEN heartbeat_at_ms
        ELSE NULL
      END,
      CASE
        WHEN status = 'running' THEN heartbeat_at_ms
        ELSE NULL
      END,
      claim_host_id,
      claim_pid,
      claim_nonce,
      claimed_at_ms
    FROM flows_runs
    WHERE status = 'running' OR claim_host_id IS NOT NULL
    ON CONFLICT (run_id) DO NOTHING
  `
})

export default consensus
