/**
 * The heartbeat lease constants, re-exported from the journal's consensus
 * module.
 *
 * A leaf module on purpose. `RunStore` needs the staleness cutoff for its
 * steal and claim predicates and `Ownership` needs all three for the
 * supervision loop, but `Ownership` imports `RunStore`, so neither could own
 * the constants without the other restating them. The definitions themselves
 * moved to `@smthrs/journal`'s `Consensus` when arbitration did: every
 * consensus strategy judges R5 staleness against the same cutoff this store
 * uses, and one definition is what keeps that structural.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md` and
 * `docs/specs/Concepts/Journal Consensus.md`.
 *
 * @since 0.1.0
 */

export {
  /**
   * Heartbeat cadence adopted from `RUN_HEARTBEAT_MS` in the Run Ownership
   * vault note.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatInterval,
  /**
   * How far the owner's wall clock may run behind a peer's before the lease
   * reasoning stops holding.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatSkewAllowance,
  /**
   * Heartbeat staleness cutoff adopted from `RUN_HEARTBEAT_STALE_MS` in the
   * Run Ownership vault note.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatStaleAfter,
  /**
   * How long the owner may keep working through *failing* heartbeat writes.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatWriteTolerance
} from "@smthrs/journal/Consensus"
