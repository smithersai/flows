/**
 * A single waiting-reason taxonomy for parked runs.
 *
 * `reason` and `wake_at_ms` earn columns because a supervisor sweeper queries
 * them directly (`WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <=
 * ?`); `token` is compare-and-swap/lookup material a wake handler matches
 * against. Anything else a wait payload might carry stays in `state_json`.
 *
 * Governing design: smithers-replacement audit P0 #2 — express every wait
 * reason (approval / event / timer / quota) through one open taxonomy on
 * `DurableEngineState` rather than per-reason inline states. Vault:
 * [[Run Ownership]] (`docs/specs/Concepts/Run Ownership.md`) and
 * [[Engine Hardening Round 1]]
 * (`docs/specs/Concepts/Engine Hardening Round 1.md`), section 5.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Adds the waiting-reason taxonomy columns to `flows_runs`.
 *
 * @category migrations
 * @since 0.1.0
 */
const waitingReason: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE flows_runs ADD COLUMN waiting_reason TEXT`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN waiting_wake_at_ms INTEGER`
  yield* sql`ALTER TABLE flows_runs ADD COLUMN waiting_token TEXT`

  yield* sql`
    CREATE INDEX flows_runs_waiting_reason_wake_at_idx
    ON flows_runs (waiting_reason, waiting_wake_at_ms)
    WHERE waiting_reason IS NOT NULL
  `
})

export default waitingReason
