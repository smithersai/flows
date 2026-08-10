/**
 * Sandbox-level liveness taxonomy and probe primitive.
 *
 * The journal's run-ownership heartbeat detects a dead engine owner; nothing
 * detected a dead sandbox under a live engine. This module closes that gap
 * with a small, honest primitive: a typed health state (`Healthy` /
 * `Unhealthy` with `component: "sandbox"` and a closed reason set) and a
 * `probe` that runs a provider ping under a deadline, mapping a failed ping
 * to `ping_failed` and a ping that never answers to `unresponsive`. It is a
 * taxonomy plus a probe, not a supervisor — no polling loop lives here.
 *
 * Everything is browser-safe: the probe only runs the effect a provider
 * hands it, and host access stays behind the provider layer.
 *
 * @since 0.1.0
 */
import { Context, type Duration, Effect, Layer, Schema } from "effect"
import type { ProviderError } from "./RemoteSandbox.ts"

/**
 * The closed set of reasons a sandbox probe reports as unhealthy.
 *
 * Reasons are a STABLE public contract, like the Host error codes: callers
 * branch on them and UIs map them to remediation. Never repurpose a reason —
 * add one.
 *
 *  - `unresponsive` — the ping did not answer within the probe deadline; the
 *    sandbox is dead or wedged, distinguishable from merely slow work.
 *  - `ping_failed`  — the ping answered with a provider failure; the session
 *    is reachable enough to refuse.
 *
 * @category models
 * @since 0.1.0
 */
export const UnhealthyReason = Schema.Literals(["unresponsive", "ping_failed"])

/**
 * @category models
 * @since 0.1.0
 */
export type UnhealthyReason = typeof UnhealthyReason.Type

/**
 * The sandbox answered its ping within the deadline.
 *
 * @category models
 * @since 0.1.0
 */
export class Healthy extends Schema.Class<Healthy>("flows/host/SandboxHealth/Healthy")({
  _tag: Schema.tag("Healthy")
}) {}

/**
 * The sandbox did not prove liveness: the ping failed or never answered.
 *
 * `component` names the failed component so an "engine alive, sandbox dead"
 * diagnosis is explicit rather than inferred from a generic provider error.
 *
 * @category models
 * @since 0.1.0
 */
export class Unhealthy extends Schema.Class<Unhealthy>("flows/host/SandboxHealth/Unhealthy")({
  _tag: Schema.tag("Unhealthy"),
  component: Schema.Literal("sandbox"),
  reason: UnhealthyReason,
  message: Schema.optional(Schema.String)
}) {}

/**
 * The full sandbox health state a probe can report.
 *
 * @category models
 * @since 0.1.0
 */
export const HealthState = Schema.Union([Healthy, Unhealthy])

/**
 * @category models
 * @since 0.1.0
 */
export type HealthState = typeof HealthState.Type

/**
 * The ping capability a remote-sandbox provider exposes to the probe.
 *
 * A ping is any cheap round-trip that proves the sandbox side is alive
 * (an `echo`, a control-channel no-op). It reuses `ProviderError` so
 * providers keep one failure surface.
 *
 * @category models
 * @since 0.1.0
 */
export interface PingProvider {
  readonly ping: Effect.Effect<void, ProviderError>
}

/**
 * @category models
 * @since 0.1.0
 */
export interface ProbeOptions {
  /** How long the ping may take before the sandbox counts as dead. Default 5 seconds. */
  readonly deadline?: Duration.Input | undefined
}

const defaultDeadline: Duration.Input = "5 seconds"

/**
 * Runs one ping under a deadline and reports the typed health state.
 *
 * Never fails: a failed ping becomes `Unhealthy(reason: "ping_failed")`, a
 * ping that outlives the deadline becomes `Unhealthy(reason: "unresponsive")`.
 * This is what lets a caller distinguish "sandbox dead" from "slow command":
 * the probe answers within the deadline either way.
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

/**
 * Sandbox health probe service.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  /** One probe: pings the sandbox and reports the typed health state. */
  readonly check: Effect.Effect<HealthState>
}

/**
 * Sandbox health service tag.
 *
 * @category services
 * @since 0.1.0
 */
export const SandboxHealth: Context.Service<Service, Service> = Context.Service(
  "flows/host/SandboxHealth"
)

/**
 * Builds the service from a provider's ping capability.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (provider: PingProvider, options?: ProbeOptions): Service =>
  SandboxHealth.of({ check: probe(provider, options) })

/**
 * Provides `SandboxHealth` backed by the given provider ping.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (provider: PingProvider, options?: ProbeOptions): Layer.Layer<Service> =>
  Layer.succeed(SandboxHealth, make(provider, options))

/**
 * A no-op service that always reports `Healthy`, for hosts without a remote
 * sandbox (including the browser).
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service => SandboxHealth.of({ check: Effect.succeed(new Healthy()) })

/**
 * Layer form of {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Service> = Layer.sync(SandboxHealth, makeNoop)
