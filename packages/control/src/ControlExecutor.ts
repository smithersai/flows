/**
 * Acceptance port from the control plane into a real run executor.
 *
 * Governing contract: `docs/specs/Concepts/Control API.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import type { LaunchFailed } from "./ControlError.ts"
import type { StoredPlan } from "./ControlRuntime.ts"
import type { RunSummary } from "./ControlSchema.ts"

/** @category models @since 0.1.0 */
export interface Launch {
  readonly plan: StoredPlan
  readonly run: RunSummary
}

/** @category models @since 0.1.0 */
export type Acceptance = "accepted" | "pending"

/** @category services @since 0.1.0 */
export interface Service {
  readonly launch: (input: Launch) => Effect.Effect<Acceptance, LaunchFailed>
}

/** @category services @since 0.1.0 */
export class ControlExecutor extends Context.Service<ControlExecutor, Service>()(
  "/control/ControlExecutor"
) {}

/** @category constructors @since 0.1.0 */
export const make = (implementation: Service): Service => ControlExecutor.of(implementation)

/** @category constructors @since 0.1.0 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    launch: Effect.fn("ControlExecutor.launch")(() => Effect.succeed("pending" as const)),
    ...overrides
  })

/** @category layers @since 0.1.0 */
export const layer = (implementation: Service): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(make(implementation))

/** @category layers @since 0.1.0 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(makeNoop(overrides))
