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
 * Creates the `flows_consensus_leases` table.
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
})

export default consensus
