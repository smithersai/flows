/**
 * The black-box engine *subject* seam used by conformance pins.
 *
 * This is the test-owned port: a pin drives an arbitrary engine implementation
 * through `run`/`result`/`interrupt`/`resume`/`journal` and asserts on the
 * journal it produced. It is deliberately distinct from the production harness
 * port `/harness/EngineLike` (`sealStep`/`splice`/`suspend`), which is
 * the seam the built-in harness *consumes*. The two are never interchangeable
 * and no longer share a name.
 *
 * Governing contract: `docs/specs/Concepts/Vendored Flow Engine.md`.
 *
 * @since 0.0.0
 */
// TODO(engine): replace with the vendored flow engine's public seam when it lands.
import { Context, Effect, Layer } from "effect"
import type { EngineSubjectError } from "./TestingError.ts"
import { EngineUnavailableError } from "./TestingError.ts"

/** @since 0.0.0 @category models */
export type StepSpec =
  | {
    readonly key: string
    readonly sealed: boolean
    readonly kind: "step"
    /**
     * A pin-supplied step body. Its error channel is `unknown` because the
     * *pin* chooses the failure value it wants the subject to journal; it is
     * not a laundered engine error.
     */
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>
  }
  | {
    readonly key: string
    readonly sealed: boolean
    readonly kind: "race"
    readonly branches: ReadonlyArray<StepSpec>
  }

/** @since 0.0.0 @category models */
export interface FlowSpec {
  readonly name: string
  readonly steps: ReadonlyArray<StepSpec>
}

/** @since 0.0.0 @category models */
export interface JournalEntryLike {
  readonly index: number
  readonly stepKey: string
  readonly kind: string
  readonly outcome: "completed" | "aborted" | "failed" | "suspended"
  readonly value?: unknown
}

/** @since 0.0.0 @category models */
export interface ExecutionResult {
  readonly executionId: string
  readonly status: "completed" | "aborted" | "failed" | "suspended"
  readonly value?: unknown
}

/** @since 0.0.0 @category services */
export interface EngineSubject {
  readonly name: string
  readonly run: (options: {
    readonly flow: FlowSpec
    readonly payload: unknown
    readonly executionId?: string
    readonly idempotencyKey?: string
  }) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly result: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly interrupt: (executionId: string) => Effect.Effect<void, EngineSubjectError>
  readonly resume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly journal: (executionId: string) => Effect.Effect<ReadonlyArray<JournalEntryLike>, EngineSubjectError>
}

/** @since 0.0.0 @category services */
export const EngineSubject: Context.Service<EngineSubject, EngineSubject> = Context.Service(
  "flows/testing/EngineSubject"
)

/** @since 0.0.0 @category constructors */
export const make = (implementation: EngineSubject): EngineSubject => EngineSubject.of(implementation)

/** @since 0.0.0 @category layers */
export const layer = (implementation: EngineSubject): Layer.Layer<EngineSubject> =>
  Layer.succeed(EngineSubject)(make(implementation))

const unavailable = (operation: string): EngineUnavailableError =>
  new EngineUnavailableError({ message: `no engine subject is available for ${operation}` })

/** @since 0.0.0 @category constructors */
export const makeNoop = (overrides: Partial<EngineSubject> = {}): EngineSubject =>
  EngineSubject.of({
    name: "unavailable",
    run: () => Effect.fail(unavailable("run")),
    result: () => Effect.fail(unavailable("result")),
    interrupt: () => Effect.fail(unavailable("interrupt")),
    resume: () => Effect.fail(unavailable("resume")),
    journal: () => Effect.fail(unavailable("journal")),
    ...overrides
  })

/** @since 0.0.0 @category layers */
export const layerNoop = (overrides: Partial<EngineSubject> = {}): Layer.Layer<EngineSubject> =>
  Layer.succeed(EngineSubject)(makeNoop(overrides))
