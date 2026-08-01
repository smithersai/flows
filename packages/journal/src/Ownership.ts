/**
 * Structural run ownership identities and heartbeat supervision.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import { Clock, Duration, Effect, Schema } from "effect"
import { RunStore } from "./RunStore.ts"

/**
 * A process identity scoped to a host and a unique ownership nonce.
 *
 * @since 0.1.0
 * @category models
 */
export const OwnerId = Schema.Struct({
  hostId: Schema.String,
  pid: Schema.Number,
  nonce: Schema.String
})

/**
 * A process identity scoped to a host and a unique ownership nonce.
 *
 * @since 0.1.0
 * @category models
 */
export type OwnerId = typeof OwnerId.Type

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
 * `heartbeatStaleAfter` old, so transient write errors are tolerated until
 * that window closes. Every successful pulse re-arms the window.
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
    const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)
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
          Effect.catch(() => nowMs - lastPulseMs >= staleAfterMs ? Effect.interrupt : Effect.void)
        )
      ),
      Effect.forever
    )
  })
