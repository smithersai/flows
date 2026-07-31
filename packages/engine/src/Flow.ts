/**
 * Defines typed durable flows.
 *
 * A `Flow` has a stable tag, schemas for payload, success, and failure, and
 * an optional idempotency key used to derive execution ids when the caller does
 * not provide one. Flow definitions can be executed, discarded, polled,
 * interrupted, resumed, and registered with a handler layer. This module also
 * includes flow result types, compensation and cleanup helpers, suspension
 * support, and settings for defect capture or failure suspension.
 *
 * @since 4.0.0
 */
import * as Digest from "@smithers/keys/Digest"
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Filter from "effect/Filter"
import { constFalse, constTrue, dual, identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import * as Tranformation from "effect/SchemaTransformation"
import * as Scope from "effect/Scope"
import type { ExitEncoded } from "effect/unstable/rpc/RpcMessage"
import type { FlowEngine, FlowInstance } from "./FlowEngine.ts"

const TypeId = "~effect/flow/Flow"

/**
 * A flow execution was requested without either a caller-selected
 * execution ID or an opt-in flow idempotency key.
 *
 * @category errors
 * @since 0.1.0
 */
export class ExecutionIdRequired extends Schema.TaggedErrorClass<ExecutionIdRequired>()(
  "@smithers/engine/ExecutionIdRequired",
  {
    code: Schema.Literal("execution_id_required").pipe(
      Schema.withConstructorDefault(Effect.succeed("execution_id_required"))
    ),
    flowName: Schema.String
  }
) {}

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
  readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined

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
    | FlowEngine
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
    FlowEngine | Success["DecodingServices"] | Error["DecodingServices"]
  >

  /**
   * Interrupt a flow execution for the given execution ID.
   */
  readonly interrupt: (
    executionId: string
  ) => Effect.Effect<void, never, FlowEngine>

  /**
   * Manually resume a flow execution for the given execution ID.
   */
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, FlowEngine>

  /**
   * Create a layer that registers the flow and provides an effect to
   * execute it.
   */
  readonly toLayer: <R>(
    execute: (
      payload: Payload["Type"],
      executionId: string
    ) => Effect.Effect<Success["Type"], Error["Type"], R>
  ) => Layer.Layer<
    never,
    never,
    | FlowEngine
    | Exclude<
      R,
      FlowEngine | FlowInstance | Execution<Tag> | Scope.Scope
    >
    | Payload["DecodingServices"]
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  >

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
   * Add compensation logic to an effect inside a Flow.
   *
   * **Details**
   *
   * The compensation finalizer is called if the entire flow fails, allowing you to perform cleanup or other actions based on the success value and the cause of the flow failure.
   *
   * **Gotchas**
   *
   * Compensation finalizers are only registered for top-level effects in the flow and do not work for nested activities.
   */
  readonly withCompensation: {
    <A, R2>(
      compensation: (
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
      compensation: (
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
  readonly idempotencyKey?: ((payload: any) => string) | undefined
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
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, FlowEngine>
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

const EngineTag = Context.Service<FlowEngine, FlowEngine["Service"]>(
  "effect/flow/FlowEngine" satisfies typeof FlowEngine.key
)

const InstanceTag = Context.Service<
  FlowInstance,
  FlowInstance["Service"]
>(
  "effect/flow/FlowEngine/FlowInstance" satisfies typeof FlowInstance.key
)

const makeExecutionIdFromPayload = (self: AnyWithProps, payload: unknown): Effect.Effect<string> => {
  const idempotencyKey = self.idempotencyKey
  return idempotencyKey === undefined
    ? Effect.die(new ExecutionIdRequired({ flowName: self._tag }))
    : Effect.sync(() => Digest.digest(`${self._tag}-${idempotencyKey(payload)}`))
}

const resolveExecutionId = (
  self: AnyWithProps,
  payload: unknown,
  executionId: string | undefined
): Effect.Effect<string> =>
  executionId === undefined
    ? makeExecutionIdFromPayload(self, payload)
    : Effect.succeed(executionId)

const Proto = {
  [TypeId]: TypeId,
  annotate(this: AnyWithProps, tag: Context.Key<any, any>, value: any) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      annotations: Context.add(this.annotations, tag, value),
      idempotencyKey: this.idempotencyKey
    })
  },
  annotateMerge(this: AnyWithProps, context: Context.Context<any>) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      annotations: Context.merge(this.annotations, context),
      idempotencyKey: this.idempotencyKey
    })
  },
  execute<const Discard extends boolean = false>(
    this: AnyWithProps,
    fields: any,
    opts?: {
      readonly discard?: Discard
      readonly executionId?: string | undefined
    } | undefined
  ) {
    return Effect.suspend(() => {
      const payload = this.payloadSchema.make(fields)
      return Effect.flatMap(
        resolveExecutionId(this, payload, opts?.executionId),
        (executionId) =>
          Effect.flatMap(EngineTag, (engine) =>
            Effect.andThen(
              Effect.annotateCurrentSpan({ executionId }),
              engine.execute(this as any, {
                executionId,
                payload,
                discard: opts?.discard
              })
            ))
      )
    }).pipe(
      Effect.withSpan(
        `${this._tag}.execute`,
        {},
        { captureStackTrace: false }
      )
    ) as any
  },
  poll(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top>, executionId: string) {
    return Effect.flatMap(EngineTag, (engine) => engine.poll(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.poll`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  interrupt(this: AnyWithProps, executionId: string) {
    return Effect.flatMap(EngineTag, (engine) => engine.interrupt(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.interrupt`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  resume(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top>, executionId: string) {
    return Effect.flatMap(EngineTag, (engine) => engine.resume(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.resume`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  toLayer(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top>, execute: any) {
    return Layer.effectDiscard(
      Effect.flatMap(EngineTag, (engine) => engine.register(this, execute))
    )
  },
  executionId(this: AnyWithProps, payload: any) {
    return Effect.flatMap(
      Effect.orDie(this.payloadSchema.makeEffect(payload)),
      (payload) => makeExecutionIdFromPayload(this, payload)
    )
  },
  withCompensation: ((...args: ReadonlyArray<any>) => (withCompensation as any)(...args))
}

const makeProto = <
  const Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(options: {
  readonly _tag: Tag
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly annotations: Context.Context<never>
  readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined
}): Flow<Tag, Payload, Success, Error> => {
  function Flow() {}
  Object.setPrototypeOf(Flow, Proto)
  Object.assign(Flow, options)
  return Flow as any
}

/**
 * Creates a durable flow definition with schemas, annotations, and either
 * caller-selected execution IDs or opt-in deterministic IDs derived from the
 * flow tag and idempotency key.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(tag: Tag, options: {
  readonly payload: Payload
  readonly idempotencyKey?:
    | ((
      payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload>
        : Payload["Type"]
    ) => string)
    | undefined
  readonly success?: Success
  readonly error?: Error
  readonly annotations?: Context.Context<never>
}): Flow<
  Tag,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
> =>
  makeProto<Tag, Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload, Success, Error>({
    _tag: tag,
    payloadSchema: (Schema.isSchema(options.payload)
      ? options.payload
      : Schema.Struct(options.payload as any)) as Payload extends Schema.Struct.Fields ? Schema.Struct<Payload>
        : Payload,
    successSchema: options.success ?? (Schema.Void as any),
    errorSchema: options.error ?? (Schema.Never as any),
    annotations: options.annotations ?? Context.empty(),
    idempotencyKey: options.idempotencyKey as any
  })

const ResultTypeId = "~effect/flow/Flow/Result"

/**
 * Returns `true` when a value is a flow `Result`.
 *
 * @category results
 * @since 4.0.0
 */
export const isResult = <A = unknown, E = unknown>(
  u: unknown
): u is Result<A, E> => Predicate.hasProperty(u, ResultTypeId)

/**
 * Result of a flow execution, either a completed exit or a suspended
 * flow state.
 *
 * @category results
 * @since 4.0.0
 */
export type Result<A, E> = Complete<A, E> | Suspended

/**
 * Encoded representation of a flow `Result`.
 *
 * @category results
 * @since 4.0.0
 */
export type ResultEncoded<A, E> =
  | CompleteEncoded<A, E>
  | typeof Suspended.Encoded

/**
 * Encoded representation of a completed flow result containing an encoded
 * `Exit`.
 *
 * @category results
 * @since 4.0.0
 */
export interface CompleteEncoded<A, E> {
  readonly _tag: "Complete"
  readonly exit: ExitEncoded<A, E>
}

/**
 * Schema constructor for `Complete` flow results using the supplied
 * success and error schemas.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface CompleteSchema<
  Success extends Schema.Constraint,
  Error extends Schema.Constraint
> extends
  Schema.declareConstructor<
    Complete<Success["Type"], Error["Type"]>,
    Complete<Success["Encoded"], Error["Encoded"]>,
    readonly [Schema.Exit<Success, Error, Schema.Defect>]
  >
{
  readonly success: Success
  readonly error: Error
}

/**
 * Represents a completed flow execution with its success or failure `Exit`.
 *
 * @category results
 * @since 4.0.0
 */
export class Complete<A, E> extends Data.TaggedClass("Complete")<{
  readonly exit: Exit.Exit<A, E>
}> {
  /**
   * Marks this value as a flow result for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ResultTypeId] = ResultTypeId

  /**
   * Builds the schema for completed flow results from success and error schemas.
   *
   * @since 4.0.0
   */
  static Schema<Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly success: Success
    readonly error: Error
  }): CompleteSchema<Success, Error> {
    // TODO: extract to a helper function
    const schema = Schema.declareConstructor<
      Complete<Success["Type"], Error["Type"]>,
      Complete<Success["Encoded"], Error["Encoded"]>
    >()(
      [Schema.Exit(options.success, options.error, Schema.Defect())],
      ([exit]) => (input, ast, options) => {
        if (!(isResult(input) && input._tag === "Complete")) {
          return Effect.fail(new SchemaIssue.InvalidType(ast, Option.some(input)))
        }
        return Effect.mapBothEager(
          SchemaParser.decodeEffect(exit)(input.exit, options),
          {
            onSuccess: (exit) => new Complete({ exit }),
            onFailure: (issue) =>
              new SchemaIssue.Composite(ast, Option.some(input), [
                new SchemaIssue.Pointer(["exit"], issue)
              ])
          }
        )
      },
      {
        expected: "Flow.Complete",
        toCodecJson: ([exit]) =>
          Schema.link<Complete<Success["Encoded"], Error["Encoded"]>>()(
            Schema.Struct({
              _tag: Schema.tag("Complete"),
              exit
            }),
            Tranformation.transform({
              decode: (encoded) => new Complete({ exit: encoded.exit }),
              encode: (result) => (({
                _tag: "Complete",
                exit: result.exit
              }) as const)
            })
          )
      }
    )
    return Schema.make(schema.ast, {
      success: options.success,
      error: options.error
    })
  }
}

/**
 * Represents a suspended flow execution, optionally carrying the cause that
 * triggered suspension.
 *
 * @category results
 * @since 4.0.0
 */
export class Suspended extends Schema.Class<Suspended>(
  "effect/flow/Flow/Suspended"
)({
  _tag: Schema.tag("Suspended"),
  cause: Schema.optional(Schema.Cause(Schema.Never, Schema.Defect()))
}) {
  /**
   * Marks this value as a flow result for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ResultTypeId] = ResultTypeId
}

/**
 * Creates a schema for flow results using the supplied success and error
 * schemas.
 *
 * @category results
 * @since 4.0.0
 */
export const Result = <
  Success extends Schema.Constraint,
  Error extends Schema.Constraint
>(options: {
  readonly success: Success
  readonly error: Error
}) => Schema.Union([Complete.Schema(options), Suspended])

const AnyOrVoid = Schema.Union([Schema.Any, Schema.Void])

/**
 * Schema for encoded flow results with generic success and error payloads.
 *
 * @category results
 * @since 4.0.0
 */
export const ResultEncoded: Schema.Codec<ResultEncoded<any, any>> = Schema.toEncoded(
  Schema.toCodecJson(
    Result({
      success: AnyOrVoid,
      error: AnyOrVoid
    })
  )
) as any

/**
 * Runs an effect as a flow execution and converts its outcome into a
 * `Result`, handling suspension, defect capture, interruption, and flow
 * scope finalization.
 *
 * @category results
 * @since 4.0.0
 */
export const intoResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  Result<A, E>,
  never,
  Exclude<R, Scope.Scope> | FlowInstance
> =>
  Effect.contextWith((context: Context.Context<FlowInstance>) => {
    const instance = Context.get(context, InstanceTag)
    const captureDefects = Context.get(instance.flow.annotations, CaptureDefects)
    const suspendOnFailure = Context.get(instance.flow.annotations, SuspendOnFailure)
    return effect.pipe(
      // so we can use external interruption to suspend the flow
      Effect.forkChild({ startImmediately: true }),
      Effect.flatMap((fiber) => Effect.onInterrupt(Fiber.join(fiber), () => Fiber.interrupt(fiber))),
      Effect.interruptible,
      suspendOnFailure
        ? Effect.catchCause((cause) => {
          instance.suspended = true
          if (!Cause.hasInterruptsOnly(cause)) {
            instance.cause = Cause.die(Cause.squash(cause))
          }
          return Effect.interrupt
        })
        : identity,
      Effect.scoped,
      Effect.matchCauseEffect({
        onSuccess: (value) => Effect.succeed(new Complete({ exit: Exit.succeed(value) })),
        onFailure: (cause): Effect.Effect<Result<A, E>> => {
          const [reasons, interrupts] = Arr.partition(
            cause.reasons,
            Filter.fromPredicate(Cause.isInterruptReason)
          )
          const hasInterruptsOnly = interrupts.length === cause.reasons.length
          const filtered = reasons.length === 0 ? cause : Cause.fromReasons(reasons)
          return instance.suspended && hasInterruptsOnly
            ? Effect.succeed(new Suspended({ cause: instance.cause }))
            : (!instance.interrupted && hasInterruptsOnly) ||
                (!captureDefects && Cause.hasDies(cause))
            ? Effect.failCause(filtered as Cause.Cause<never>)
            : Effect.succeed(new Complete({ exit: Exit.failCause(filtered) }))
        }
      }),
      (eff) =>
        Effect.onExitPrimitive(eff, (exit) => {
          if (Exit.isFailure(exit)) {
            return Scope.close(instance.scope, exit)
          } else if (exit.value._tag === "Complete") {
            return Scope.close(instance.scope, exit.value.exit)
          }
          return Effect.void
        }, true),
      Effect.uninterruptible
    )
  })

/**
 * Wraps an activity-like effect so flow suspension waits for currently
 * running activities to finish or suspend.
 *
 * @category results
 * @since 4.0.0
 */
export const wrapActivityResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  isSuspend: (value: A) => boolean
): Effect.Effect<A, E, R | FlowInstance> =>
  Effect.contextWith((context: Context.Context<FlowInstance>) => {
    const instance = Context.get(context, InstanceTag)
    const state = instance.activityState
    if (state.count === 0) state.latch.closeUnsafe()
    state.count++
    return Effect.onExit(effect, (exit) => {
      state.count--
      const isSuspended = Exit.isSuccess(exit) && isSuspend(exit.value)
      if (
        Exit.isSuccess(exit) &&
        isResult(exit.value) &&
        exit.value._tag === "Suspended" &&
        exit.value.cause
      ) {
        instance.cause = instance.cause
          ? Cause.combine(instance.cause, exit.value.cause)
          : exit.value.cause
      }
      return state.count === 0
        ? state.latch.open
        : isSuspended
        ? waitForZero(instance)
        : Effect.void
    })
  })

// Untraced because this latch loop is a flow scheduler hot path.
const waitForZero = Effect.fnUntraced(function*(instance: FlowInstance["Service"]) {
  const state = instance.activityState
  while (true) {
    if (state.count > 0) {
      yield* state.latch.await
      yield* Effect.yieldNow
      continue
    }
    yield* Effect.yieldNow
    if (state.count === 0) return
  }
})

/**
 * Accesses the flow scope, which is only closed when the flow execution fully completes.
 *
 * @category resource management
 * @since 4.0.0
 */
export const scope: Effect.Effect<
  Scope.Scope,
  never,
  FlowInstance
> = Effect.map(
  InstanceTag,
  (instance) => instance.scope as Scope.Scope
)

/**
 * Provides the flow scope to the given effect, and closes the scope only when the flow execution fully completes.
 *
 * @category resource management
 * @since 4.0.0
 */
export const provideScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | FlowInstance> =>
  Effect.flatMap(scope, (scope) => Scope.provide(effect, scope))

/**
 * Adds an exit finalizer to the current flow scope, preserving the
 * services available when the finalizer is registered.
 *
 * @category resource management
 * @since 4.0.0
 */
export const addFinalizer: <R>(
  f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
) => Effect.Effect<
  void,
  never,
  FlowInstance | R
> =
  // Untraced because suspension recursively re-enters flow execution.
  Effect.fnUntraced(function*<R>(
    f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
  ) {
    const scope = (yield* InstanceTag).scope
    const services = yield* Effect.context<R>()
    yield* Scope.addFinalizerExit(scope, (exit) => Effect.provideContext(f(exit), services))
  })

/**
 * Adds compensation logic to an effect inside a Flow.
 *
 * **When to use**
 *
 * Use when a top-level flow step needs compensating cleanup if the overall
 * flow later fails after the step succeeds.
 *
 * **Details**
 *
 * The compensation finalizer is called if the entire flow fails, allowing you to perform cleanup or other actions based on the success value and the cause of the flow failure.
 *
 * **Gotchas**
 *
 * Compensation finalizers are only registered for top-level effects in the flow and do not work for nested activities.
 *
 * @category Compensation
 * @since 4.0.0
 */
export const withCompensation: {
  <A, R2>(
    compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): <E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope>
  <A, E, R, R2>(
    effect: Effect.Effect<A, E, R>,
    compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope>
} = dual(2, <A, E, R, R2>(
  effect: Effect.Effect<A, E, R>,
  compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
): Effect.Effect<A, E, R | R2 | FlowInstance | Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.tap(
      restore(effect),
      (value) => addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : compensation(value, exit.cause))
    )
  ))

/**
 * Marks a flow instance as suspended and interrupts the current fiber to
 * stop execution until it is resumed.
 *
 * @category results
 * @since 4.0.0
 */
export const suspend = (instance: FlowInstance["Service"]): Effect.Effect<never> =>
  Effect.interruptible(Effect.callback<never>(() => {
    instance.suspended = true
    const fiber = Fiber.getCurrent()!
    fiber.interruptUnsafe(fiber.id)
  }))

/**
 * Captures defects for a flow and includes them in the result of the flow or its activities.
 *
 * **Details**
 *
 * By default, this annotation is set to `true`, meaning defects are captured.
 *
 * @category annotations
 * @since 4.0.0
 */
export const CaptureDefects = Context.Reference<boolean>(
  "effect/flow/Flow/CaptureDefects",
  {
    defaultValue: constTrue
  }
)

/**
 * Marks a flow to suspend when it encounters any error.
 *
 * **Details**
 *
 * The suspended execution can later be resumed with the flow's `resume` method, for example `MyFlow.resume(executionId)`.
 *
 * @category annotations
 * @since 4.0.0
 */
export const SuspendOnFailure = Context.Reference<boolean>(
  "effect/flow/Flow/SuspendOnFailure",
  {
    defaultValue: constFalse
  }
)
