// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines typed durable flow declarations.
 *
 * A `Flow` has a stable tag, schemas for payload, success, and failure, a
 * REQUIRED pure `body`, and an optional idempotency key used to derive
 * execution ids when the caller does not provide one. Flow definitions can be
 * executed, discarded, polled, interrupted, and resumed.
 *
 * The two nouns of `docs/specs/Concepts/Unified Flow Authoring.md` divide the
 * surface here: an Activity carries an implementation, attached separately as a
 * Layer; a Flow carries a body, and never opaque executable code. There is
 * therefore no handler to attach to a flow, and no `toLayer` on one to attach
 * it with.
 *
 * @since 4.0.0
 */
import type * as Node from "@smthrs/plan/Node"
import type * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { PlannedPayload } from "../Activity/Activity.ts"
import type { FlowInstance, FlowRuntime } from "../FlowRuntime/index.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { To } from "./Outcome.ts"
import type { Result } from "./Result.ts"
import type { TypeId } from "./TypeId.ts"

/**
 * Durable flow definition with typed payload, success, and error schemas
 * plus operations for execution, polling, interruption, resumption, and
 * registration.
 *
 * @category models
 * @since 4.0.0
 */
export interface Flow<
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
> {
  new(_: never): {}

  readonly [TypeId]: typeof TypeId
  readonly _tag: Tag
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly annotations: Context.Context<never>
  /**
   * The pure plan-time body that IS this flow's behavior.
   *
   * The payload is decoded real data and the returned node only describes
   * topology. It is a FIELD rather than an injectable layer because there is
   * exactly one of it, it is pure, and its digest enters the flow's content
   * identity, so a flow cannot plan one way under one wiring and another way
   * under another. Purity includes closure capture: the body must not read
   * mutable module state, clocks, random values, services, or environment
   * values captured outside `payload`; source-digest identity cannot observe
   * those aliases changing. Work that genuinely wants opaque code is an
   * Activity.
   */
  readonly body: (payload: Payload["Type"]) => Node.Node<unknown, unknown>
  readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  /**
   * How many rounds one trampoline lineage started from this flow may open.
   *
   * The bound is a BUDGET, not loop detection: identical consecutive rounds
   * are legal, so `docs/specs/Concepts/Trampoline Loops.md` stops a runaway
   * lineage by counting rounds instead of comparing them. Absent means
   * unbounded, which is the right default for a lineage whose exit condition
   * is its own branch. Exceeding it fails the lineage with
   * {@link module:MaxRoundsExceeded.MaxRoundsExceeded}.
   */
  readonly maxRounds?: number | undefined

  /**
   * Describes an inline call to this flow without executing it.
   */
  readonly call: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<Success["Type"], Error["Type"]>

  /**
   * Describes an explicit child boundary: ONE node in the caller's plan, and a
   * real child execution when that node is driven.
   *
   * `.call()` splices this flow's body into the caller's plan, so every inner
   * step is visible and individually keyed. `.child()` is the other choice
   * `docs/specs/Concepts/Unified Flow Authoring.md` gives: the callee keeps its
   * own execution, journal lineage, retry policy, and placement, and the caller
   * sees one leaf. It is also the way out of the two build refusals inline
   * expansion raises — a recursive `.call()` and a placement the caller cannot
   * satisfy.
   */
  readonly child: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<Success["Type"], Error["Type"]>

  /**
   * Describes a serializable invocation for the next trampoline round.
   */
  readonly to: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<To<Payload["Type"]>>

  /**
   * Add an annotation to the flow.
   */
  annotate<I, S>(
    key: Context.Key<I, S>,
    value: S
  ): Flow<Tag, Payload, Success, Error>

  /**
   * Merge multiple annotations into the flow.
   */
  annotateMerge<I>(
    annotations: Context.Context<I>
  ): Flow<Tag, Payload, Success, Error>

  /**
   * Execute the flow with the given payload.
   */
  readonly execute: <const Discard extends boolean = false>(
    payload: Payload["~type.make.in"],
    options?: {
      readonly discard?: Discard
      readonly executionId?: string | undefined
    }
  ) => Effect.Effect<
    Discard extends true ? string : Success["Type"],
    Discard extends true ? never : Error["Type"],
    | FlowRuntime
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >

  /**
   * Poll the current status of a flow execution.
   */
  readonly poll: (
    executionId: string
  ) => Effect.Effect<
    Option.Option<Result<Success["Type"], Error["Type"]>>,
    never,
    FlowRuntime | Success["DecodingServices"] | Error["DecodingServices"]
  >

  /**
   * Requests cancellation of the execution.
   *
   * This is not a pause operation. The engine interrupts active work while
   * preserving its normal cleanup, compensation, and child-flow semantics.
   * Calling `resume` does not undo the cancellation request.
   */
  readonly interrupt: (
    executionId: string
  ) => Effect.Effect<void, never, FlowRuntime>

  /**
   * Re-drives an execution that returned `Suspended` so it can replay its
   * durable history and continue after its awaited condition becomes ready.
   *
   * This does not resume an execution cancelled by `interrupt`, and it is not
   * needed for an execution that is already running or complete.
   */
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, FlowRuntime>

  /**
   * For the given payload, compute the deterministic execution ID.
   *
   * This helper is valid only when the flow declares an `idempotencyKey`.
   * Otherwise it dies with `ExecutionIdRequired`.
   */
  readonly executionId: (
    payload: Payload["~type.make.in"]
  ) => Effect.Effect<string>

  /**
   * Runs an effect and registers how to undo its successful result if the
   * enclosing flow later exits unsuccessfully.
   *
   * If the effect itself fails, no rollback is registered. If both the effect
   * and the flow succeed, the rollback is discarded. Otherwise the rollback
   * receives the effect's successful value and the flow's failure cause when
   * the flow scope closes.
   *
   * This applies only to effects run directly inside the flow execution. It
   * does not attach rollback behavior to nested activities.
   */
  readonly withRollback: {
    <A, R2>(
      rollback: (
        value: A,
        cause: Cause.Cause<Error["Type"]>
      ) => Effect.Effect<void, never, R2>
    ): <E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<
      A,
      E,
      R | R2 | FlowInstance | Execution<Tag> | Scope.Scope
    >
    <A, E, R, R2>(
      effect: Effect.Effect<A, E, R>,
      rollback: (
        value: A,
        cause: Cause.Cause<Error["Type"]>
      ) => Effect.Effect<void, never, R2>
    ): Effect.Effect<
      A,
      E,
      R | R2 | FlowInstance | Execution<Tag> | Scope.Scope
    >
  }
}

/**
 * Schema constraint for flow payload schemas that expose struct fields.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface AnyStructSchema extends Schema.Top {
  readonly fields: Schema.Struct.Fields
}

/**
 * Type-level marker for services associated with a specific flow
 * execution tag.
 *
 * @category models
 * @since 4.0.0
 */
export interface Execution<Tag extends string> {
  readonly _: unique symbol
  readonly _tag: Tag
}

/**
 * Type-erased flow shape for APIs that operate on flows without
 * preserving their specific payload, success, or error types.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  new(_: never): {}

  readonly [TypeId]: typeof TypeId
  readonly _tag: string
  readonly executionId: (payload: any) => Effect.Effect<string>
  readonly payloadSchema: AnyStructSchema
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly annotations: Context.Context<never>
  readonly body: (payload: any) => Node.Node<unknown, unknown>
  readonly idempotencyKey?: ((payload: any) => string) | undefined
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly maxRounds?: number | undefined
}

/**
 * Type-erased flow shape that also exposes executable operations needed by
 * flow proxy and engine helpers.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyWithProps extends Any {
  readonly payloadSchema: AnyStructSchema
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly execute: (
    payload: any,
    options?: {
      readonly discard?: boolean
      readonly executionId?: string | undefined
    }
  ) => Effect.Effect<any, any, any>
  /**
   * Re-drives a durably suspended execution; it does not undo cancellation.
   */
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, FlowRuntime>
}

/**
 * Extracts the payload schema from a `Flow`.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadSchema<W> = W extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Payload
  : never

/**
 * Computes the schema services required by clients that execute or poll
 * flows.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementsClient<Flows extends Any> = Flows extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  : never

/**
 * Computes the schema services required by handlers that decode flow
 * payloads and encode flow results.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementsHandler<Flows extends Any> = Flows extends Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["DecodingServices"]
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["DecodingServices"]
    | _Error["EncodingServices"]
  : never
