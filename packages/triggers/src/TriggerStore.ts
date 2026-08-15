/**
 * Durable trigger declaration and fire store.
 *
 * @see docs/specs/Concepts/Flow Triggers.md
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type { Action } from "./Overlap.ts"
import type { Trigger } from "./Trigger.ts"
import { TriggerError } from "./TriggerError.ts"

/** @category models @since 0.1.0 */
export interface Registered extends Trigger {
  readonly revision: number
  readonly lastFiredAt?: number | undefined
}
/** @category models @since 0.1.0 */
export interface Fire {
  readonly triggerId: string
  readonly occurrence: number
}
/** @category models @since 0.1.0 */
export interface ClaimFire extends Fire {
  readonly overlap: Trigger["overlap"]
  readonly resumeBuffered?: boolean | undefined
}
/** @category models @since 0.1.0 */
export type Claim =
  | { readonly claimed: false }
  | {
    readonly claimed: true
    readonly action: Action
    readonly reservationId?: string | undefined
    readonly activeRunId?: string | undefined
  }
/** @category models @since 0.1.0 */
export type Outcome = "launched" | "completed" | "skipped" | "buffered" | "superseded" | "failed"
/** @category models @since 0.1.0 */
export interface Result extends Fire {
  readonly outcome: Outcome
  readonly runId?: string | undefined
  readonly error?: string | undefined
}

/** @category models @since 0.1.0 */
export interface Service {
  readonly register: (trigger: Trigger) => Effect.Effect<Registered, TriggerError>
  readonly get: (triggerId: string) => Effect.Effect<Option.Option<Registered>, TriggerError>
  readonly list: () => Effect.Effect<ReadonlyArray<Registered>, TriggerError>
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Registered>, TriggerError>
  readonly claimFire: (fire: ClaimFire) => Effect.Effect<Claim, TriggerError>
  readonly recordResult: (result: Result) => Effect.Effect<void, TriggerError>
  readonly setPending: (fire: Fire) => Effect.Effect<void, TriggerError>
  readonly takePending: (triggerId: string) => Effect.Effect<Option.Option<number>, TriggerError>
  readonly activeRun: (triggerId: string) => Effect.Effect<Option.Option<string>, TriggerError>
  readonly clearActive: (triggerId: string, runId: string) => Effect.Effect<void, TriggerError>
}

/** @category services @since 0.1.0 */
export class TriggerStore extends Context.Service<TriggerStore, Service>()("flows/triggers/TriggerStore") {}

const unavailable = (method: string): Effect.Effect<never, TriggerError> =>
  Effect.fail(new TriggerError({ code: "store", message: `${method} is unavailable` }))

/** @category constructors @since 0.1.0 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  register: () => unavailable("register"),
  get: () => unavailable("get"),
  list: () => unavailable("list"),
  due: () => unavailable("due"),
  claimFire: () => unavailable("claimFire"),
  recordResult: () => unavailable("recordResult"),
  setPending: () => unavailable("setPending"),
  takePending: () => unavailable("takePending"),
  activeRun: () => unavailable("activeRun"),
  clearActive: () => unavailable("clearActive"),
  ...overrides
})

/** @category layers @since 0.1.0 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<TriggerStore> =>
  Layer.succeed(TriggerStore)(makeNoop(overrides))
