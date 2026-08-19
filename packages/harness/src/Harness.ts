/**
 * The neutral harness adapter contract.
 *
 * One service, implemented by anything that can run an agent step and emit
 * `AgentEvent`s: the cell path, a foreign CLI adapter, a stub. It carries no
 * loop of its own — the built-in production loop is the cell path
 * (`CellTurn`, composed by `@smthrs/engine-harness/CellHarness`), and the
 * superseded provider-tool-call loop lives in `./LegacyHarness.ts`.
 *
 * Governing design: `docs/specs/Specs/Harness.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Stream } from "effect"
import type * as AgentEvent from "./AgentEvent.ts"
import type * as AgentStep from "./AgentStep.ts"
import { HarnessError } from "./HarnessError.ts"

/**
 * The one adapter surface implemented by both the built-in loop and foreign
 * agent harnesses.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Harness {
  readonly run: (
    step: AgentStep.AgentStep,
    host: AgentStep.HostLike
  ) => Stream.Stream<AgentEvent.AgentEvent, HarnessError>
}

/**
 * Context service for the selected harness adapter.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Harness: Context.Service<Harness, Harness> = Context.Service("/harness/Harness")

const unavailable = (): HarnessError =>
  new HarnessError({
    code: "invalid_step",
    message: "No harness implementation is configured"
  })

/**
 * Constructs an unavailable harness stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Harness> = {}): Harness =>
  Harness.of({
    run: () => Stream.unwrap(Effect.fn("Harness.run")(() => Effect.succeed(Stream.fail(unavailable())))()),
    ...overrides
  })

/**
 * Provides an unavailable harness stub.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Harness> = {}): Layer.Layer<Harness> =>
  Layer.succeed(Harness)(makeNoop(overrides))
