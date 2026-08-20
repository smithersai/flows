/**
 * Narrow engine port consumed by the built-in harness.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Effect Harness.md`,
 * `docs/specs/Concepts/Flow Builder Brief.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Vendored Flow Engine.md`.
 *
 * @since 0.1.0
 */
import type * as KeyMaterial from "@smthrs/core/KeyMaterial"
import type * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type * as Cell from "./Cell.ts"
import { HarnessError } from "./HarnessError.ts"
import type * as Plan from "./Plan.ts"

/**
 * Stable reasons for parking a harness turn at a safe boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SuspendReasonCode = Schema.Literals([
  "permission-required",
  "waiting-quota",
  "waiting-input",
  "waiting-event",
  "engine"
])

/**
 * Stable reasons for parking a harness turn at a safe boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SuspendReasonCode = typeof SuspendReasonCode.Type

/**
 * A serializable request to park the current engine frame.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class SuspendReason extends Schema.Class<SuspendReason>("flows/harness/EngineLike/SuspendReason")({
  code: SuspendReasonCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown)
}) {}

/**
 * A sealed model request and the complete digest-free material declared by the
 * harness.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SealedModelStep {
  readonly request: ModelRequest.ModelRequest
  readonly keyMaterial: KeyMaterial.KeyMaterial
}

/**
 * The durable identity of one journaled controller boundary.
 *
 * `boundary` is a deterministic label for the boundary within its frame — a
 * cell digest or a context digest — so re-executing the frame derives the same
 * identity and replays the recorded value instead of performing the read
 * again.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BoundaryIdentity {
  /** The durable session or lineage the boundary belongs to, when the loop has one. */
  readonly session?: string | undefined
  readonly frame: number
  readonly boundary: string
}

/**
 * A schema that decodes without services — the only kind a durable store can
 * reconstruct a journaled value with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DurableSchema<A> = Schema.Schema<A> & { readonly "DecodingServices": never }

/**
 * One nondeterministic read the controller must perform exactly once per run.
 *
 * The canonical example is the turn-boundary steering drain: the host queue is
 * the world, and draining it is an effect. Left unjournaled, a resumed run
 * drains an already-drained queue, rebuilds a different context than the
 * original attempt, re-keys every later sealed step, and re-executes
 * irreversible effects. Recorded through {@link EngineLike.record}, the drain
 * replays its recorded value and the resumed run converges on the original
 * attempt.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RecordBoundary<A> {
  readonly name: string
  readonly identity: BoundaryIdentity
  readonly success: DurableSchema<A>
  readonly execute: Effect.Effect<A, HarnessError>
}

/**
 * The engine operations required by harness translation.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface EngineLike {
  /**
   * Runs one sealed model step.
   *
   * The harness contributes the assembled-context input, resolved layer set,
   * capability envelope, effect tier, placement, and provider-neutral
   * `ModelRequest` as core key material. Route resolution happens on the
   * step-key contract (`docs/specs/Concepts/Step Keys.md`,
   * `docs/specs/Concepts/Model Layer.md`) requires the exact wire request in
   * the key. An implementation MUST therefore resolve the route, run
   * `Route.prepare` (`/model/Route`), and digest the credential-free
   * `PreparedRequest` — canonical body bytes included — together with
   * declared material into the sealed-step key before executing. A provider
   * wire change must produce a new key; credentials are signed on after the
   * digest and never enter it (`docs/reference/model.md`).
   */
  readonly sealStep: (
    step: SealedModelStep
  ) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError>
  readonly splice: (
    batch: Plan.Batch
  ) => Stream.Stream<Plan.SpliceEvent, HarnessError>
  /**
   * Runs one flow call issued from inside a running cell.
   *
   * This is the cell path's whole effectful surface, and it is deliberately
   * one call at a time: a cell derives the second call's input from the first
   * call's result, so there is no batch to hand over. The implementation owns
   * durability — the call is a keyed, journaled activity at the tier the flow
   * declares, keyed by `call.identity` so a settled boundary replays instead of
   * re-running when the cell is re-executed after a crash or a permission park.
   *
   * A flow that fails settles as a `failure` {@link Cell.CallResult}, which the
   * cell observes as a catchable exception. A permission requirement, an
   * abort, or an engine failure travels in the error channel instead, so the
   * cell never sees — and can never swallow — a park.
   */
  readonly call: (call: Cell.Call) => Effect.Effect<Cell.CallResult, HarnessError>
  /**
   * Journals one nondeterministic controller read as a durable boundary.
   *
   * The controller's state is rebuilt by re-execution, so every read of the
   * world it makes between sealed steps must be recorded: the implementation
   * runs `execute` once, journals the outcome under a run-scoped key derived
   * from `identity`, and serves the recorded value to any later re-execution
   * of the same frame. A read that bypasses this boundary is a replay
   * divergence — and, downstream of one, duplicate irreversible effects.
   */
  readonly record: <A>(boundary: RecordBoundary<A>) => Effect.Effect<A, HarnessError>
  readonly suspend: (reason: SuspendReason) => Effect.Effect<never, HarnessError>
}

/**
 * Context service for the harness engine boundary.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const EngineLike: Context.Service<EngineLike, EngineLike> = Context.Service(
  "/harness/EngineLike"
)

/**
 * Constructs an engine port from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: EngineLike): EngineLike => EngineLike.of(implementation)

/**
 * Provides an engine port implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: EngineLike): Layer.Layer<EngineLike> =>
  Layer.succeed(EngineLike)(make(implementation))

const unavailable = (operation: string, code: "engine_failed" | "suspended" = "engine_failed"): HarnessError =>
  new HarnessError({
    code,
    message: `${operation} is unavailable`
  })

/**
 * Constructs an unavailable engine stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<EngineLike> = {}): EngineLike =>
  EngineLike.of({
    sealStep: () =>
      Stream.unwrap(Effect.fn("EngineLike.sealStep")(() => Effect.succeed(Stream.fail(unavailable("sealStep"))))()),
    splice: () => Stream.fail(unavailable("splice")),
    call: Effect.fn("EngineLike.call")(() => Effect.fail(unavailable("call"))),
    record: Effect.fn("EngineLike.record")(() => Effect.fail(unavailable("record"))),
    suspend: Effect.fn("EngineLike.suspend")(() => Effect.fail(unavailable("suspend", "suspended"))),
    ...overrides
  })

/**
 * Provides an unavailable engine stub.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<EngineLike> = {}): Layer.Layer<EngineLike> =>
  Layer.succeed(EngineLike)(makeNoop(overrides))
