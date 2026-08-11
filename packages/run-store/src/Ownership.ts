/**
 * Run ownership arbitration: liveness evidence, probes, and heartbeat
 * supervision.
 *
 * The identity being arbitrated — {@link OwnerId} — is defined by
 * `@smthrs/journal`, because it is the fencing token the journal accepts on
 * durable appends. It is re-exported here so ownership callers keep reading it
 * as one vocabulary.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import { OwnerId } from "@smthrs/journal/OwnerId"
import { Clock, Duration, Effect, Schema } from "effect"
import { RunStore } from "./RunStore.ts"

export {
  /**
   * A process identity scoped to a host and a unique ownership nonce, defined
   * by `@smthrs/journal` as the fence on durable appends.
   *
   * @since 0.1.0
   * @category models
   */
  OwnerId
}

/**
 * Evidence that the owner in an exact run snapshot is no longer live.
 *
 * @since 0.1.0
 * @category models
 */
export const LivenessEvidence = Schema.Struct({
  expectedOwner: OwnerId,
  checkedAtMs: Schema.Number,
  kind: Schema.Literals(["same-host-pid-dead", "cross-host-unreachable-stale"])
})

/**
 * Evidence that the owner in an exact run snapshot is no longer live.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessEvidence = typeof LivenessEvidence.Type

/**
 * Injected liveness probe used by ownership arbitration before calling
 * `RunStore.steal`.
 *
 * A probe may inspect a PID only when `expectedOwner.hostId` equals
 * `claimant.hostId`. Cross-host checks must not inspect the local PID and fall
 * back to stale-heartbeat reachability evidence. `RunStore` only validates
 * supplied evidence and never probes a process or network itself.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessProbe<E = never, R = never> = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
) => Effect.Effect<LivenessEvidence | undefined, E, R>

/**
 * Heartbeat cadence adopted from `RUN_HEARTBEAT_MS` in the Run Ownership vault
 * note.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatInterval: Duration.Duration = Duration.seconds(1)

/**
 * Heartbeat staleness cutoff adopted from `RUN_HEARTBEAT_STALE_MS` in the Run
 * Ownership vault note.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatStaleAfter: Duration.Duration = Duration.seconds(30)

/**
 * How far the owner's wall clock may run behind a peer's before the lease
 * reasoning stops holding.
 *
 * The owner stamps `heartbeat_at_ms` from *its* clock and a would-be stealer
 * compares that stamp against *its own*, so the two hosts' clock offset is
 * subtracted directly from the owner's real safety margin. This constant names
 * that allowance instead of leaving it implicit in a "two ticks" arithmetic
 * accident, and it is a budgeted allowance, not a guarantee: see
 * {@link heartbeatWriteTolerance} for what happens once it is exceeded.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatSkewAllowance: Duration.Duration = Duration.seconds(10)

/**
 * How long the owner may keep working through *failing* heartbeat writes.
 *
 * A peer judges staleness by the persisted heartbeat and may steal the run the
 * instant it is {@link heartbeatStaleAfter} old, so an owner that tolerated
 * write failures for exactly that long would still be executing side effects
 * when the steal is admitted. The budget is therefore
 * {@link heartbeatStaleAfter} minus {@link heartbeatSkewAllowance} (the peer's
 * clock may already read that much later than the owner's) minus one
 * {@link heartbeatInterval} (the owner only re-evaluates the budget once per
 * pulse, so it may notice the expiry a full tick late).
 *
 * This bounds, but does not eliminate, overlap. Beyond
 * {@link heartbeatSkewAllowance} of clock offset a peer can be admitted while
 * the old owner is still running. *Durable* writes stay safe regardless — they
 * are fenced by the ownership compare-and-set, so the displaced owner's writes
 * fail rather than corrupt. Non-durable external side effects (an HTTP call, a
 * spawned process) can genuinely overlap. That is inherent to any wall-clock
 * lease and is stated here rather than asserted away; a caller that cannot
 * tolerate any overlap needs an external fencing token at the side effect
 * itself, not a larger timeout.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatWriteTolerance: Duration.Duration = Duration.millis(
  Duration.toMillis(heartbeatStaleAfter) -
    Duration.toMillis(heartbeatSkewAllowance) -
    Duration.toMillis(heartbeatInterval)
)

/**
 * Runs heartbeats until the persisted ownership fence is lost, then interrupts
 * itself. Race this effect with owned work so structured concurrency
 * interrupts the work when ownership disappears.
 *
 * Pulses are delayed by `heartbeatInterval` and read the Effect `Clock`, so the
 * loop is fully driveable with `TestClock`.
 *
 * A lost fence — any outcome other than `Updated` — is durable evidence and
 * interrupts immediately. A failed heartbeat *write* is not: the persisted
 * heartbeat is still there and no other process may steal the run until it is
 * `heartbeatStaleAfter` old, so transient write errors are tolerated for
 * `heartbeatWriteTolerance` — deliberately shorter than the steal cutoff by a
 * pulse plus `heartbeatSkewAllowance`, so an owner whose clock lags a peer's
 * by up to that allowance is still interrupted *before* the peer may steal the
 * run rather than while it is still running side effects. Past that allowance
 * the fence still protects durable writes but non-durable side effects may
 * overlap; see {@link heartbeatWriteTolerance}. Every successful pulse re-arms
 * the window.
 *
 * @since 0.1.0
 * @category supervision
 */
export const heartbeatLoop = (
  runId: string,
  owner: OwnerId
): Effect.Effect<never, never, RunStore> =>
  Effect.gen(function*() {
    const runStore = yield* RunStore
    const toleranceMs = Duration.toMillis(heartbeatWriteTolerance)
    let lastPulseMs = yield* Clock.currentTimeMillis
    return yield* Effect.sleep(heartbeatInterval).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((nowMs) =>
        runStore.heartbeat(runId, owner, nowMs).pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Updated"
              ? Effect.sync(() => {
                lastPulseMs = nowMs
              })
              : Effect.interrupt
          ),
          Effect.catch(() => nowMs - lastPulseMs >= toleranceMs ? Effect.interrupt : Effect.void)
        )
      ),
      Effect.forever
    )
  })
