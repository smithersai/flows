/**
 * Probes sandbox liveness under a deadline.
 *
 * @since 0.1.0
 */
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { HealthState } from "./HealthState.ts"
import { Healthy } from "./Healthy.ts"
import type { PingProvider } from "./PingProvider.ts"
import type { ProbeOptions } from "./ProbeOptions.ts"
import { Unhealthy } from "./Unhealthy.ts"

/**
 * Default deadline used when a probe does not specify one.
 *
 * @private
 * @since 0.1.0
 */
const defaultDeadline: Duration.Input = "5 seconds"

/**
 * Runs one ping under a deadline and reports a typed health state.
 *
 * A failed ping becomes `Unhealthy(reason: "ping_failed")`; a ping that
 * outlives the deadline becomes `Unhealthy(reason: "unresponsive")`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const probe = (
  provider: PingProvider,
  options?: ProbeOptions
): Effect.Effect<HealthState> =>
  Effect.timeoutOrElse(
    Effect.match(provider.ping, {
      onSuccess: (): HealthState => new Healthy(),
      onFailure: (error): HealthState =>
        new Unhealthy({
          component: "sandbox",
          reason: "ping_failed",
          message: error.message
        })
    }),
    {
      duration: options?.deadline ?? defaultDeadline,
      orElse: () =>
        Effect.succeed<HealthState>(
          new Unhealthy({
            component: "sandbox",
            reason: "unresponsive",
            message: "sandbox ping did not answer within the probe deadline"
          })
        )
    }
  )
