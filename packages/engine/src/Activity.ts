/**
 * Defines named effects whose results can be stored by a flow engine.
 *
 * An `Activity` is an `Effect` with a stable name and schemas for its success
 * and error values. `make` wraps an effect so the `FlowEngine` can execute
 * it, store its result, or replay that result during a flow run. This module
 * also includes helpers for retry attempts, idempotency keys, and durable races.
 *
 * @since 4.0.0
 */
import * as StepKey from "@smithers/keys/StepKey"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import { dual } from "effect/Function"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Scope } from "effect/Scope"
import type * as Types from "effect/Types"
import * as DurableDeferred from "./DurableDeferred.ts"
import * as Flow from "./Flow.ts"
import type { FlowEngine, FlowInstance } from "./FlowEngine.ts"
import type * as RetryPolicy from "./RetryPolicy.ts"

const TypeId = "~effect/flow/Activity"

/**
 * The durability and retry semantics of an activity.
 *
 * @category models
 * @since 0.1.0
 */
export type Tier = "sealed" | "compensable" | "irreversible"

/**
 * Caller-declared material for a content-addressed sealed activity.
 *
 * A string is treated as the activity body identity with empty input, layer,
 * and capability declarations. Callers that need the complete key material can
 * supply a `StepKey.ContentIdentity`.
 *
 * @category models
 * @since 0.1.0
 */
export type IdempotencyKey = string | StepKey.ContentIdentity

/**
 * Marker raised by an engine when an activity is interrupted by host loss or
 * rebalancing rather than user cancellation.
 *
 * @category errors
 * @since 0.1.0
 */
export class InfraInterrupt extends Schema.TaggedErrorClass<InfraInterrupt>()(
  "@smithers/engine/InfraInterrupt",
  {
    code: Schema.Literal("infra_interrupt").pipe(
      Schema.withConstructorDefault(Effect.succeed("infra_interrupt"))
    ),
    reason: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * An irreversible activity attempted a retry without declaring an
 * idempotency key.
 *
 * @category errors
 * @since 0.1.0
 */
export class IrreversibleRetryRequiresIdempotencyKey
  extends Schema.TaggedErrorClass<IrreversibleRetryRequiresIdempotencyKey>()(
    "@smithers/engine/IrreversibleRetryRequiresIdempotencyKey",
    {
      code: Schema.Literal("irreversible_retry_requires_idempotency_key").pipe(
        Schema.withConstructorDefault(Effect.succeed("irreversible_retry_requires_idempotency_key"))
      ),
      activityName: Schema.String,
      attempt: Schema.Number
    }
  )
{}

/**
 * Durable flow activity that behaves as an `Effect` and records its name,
 * result schemas, annotations, and encoded execution form for the flow
 * engine.
 *
 * @category models
 * @since 4.0.0
 */
export interface Activity<
  Success extends Schema.Constraint = Schema.Void,
  Error extends Schema.Constraint = Schema.Never,
  R = never
> extends
  Effect.Effect<
    Success["Type"],
    Error["Type"],
    | Success["DecodingServices"]
    | Error["DecodingServices"]
    | R
    | FlowEngine
    | FlowInstance
  >
{
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly exitSchema: Schema.Exit<Success, Error, Schema.Defect>
  readonly exitSchemaPartial: Schema.Exit<Success, Error, Schema.Unknown>
  readonly annotations: Context.Context<never>
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly metadata: unknown
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
  annotate<I, S>(
    key: Context.Key<I, S>,
    value: S
  ): Activity<Success, Error, R>
  annotateMerge<I>(
    annotations: Context.Context<I>
  ): Activity<Success, Error, R>
  readonly execute: Effect.Effect<
    Success["Type"],
    Error["Type"],
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
    | R
    | Scope
    | FlowEngine
    | FlowInstance
  >
  readonly executeEncoded: Effect.Effect<
    unknown,
    unknown,
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
    | R
    | Scope
    | FlowEngine
    | FlowInstance
  >
}

/**
 * Type-erased activity shape for APIs that only need the activity identity,
 * name, annotations, and encoded execution.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly executeEncoded: Effect.Effect<any, any, any>
  readonly annotations: Context.Context<never>
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly metadata: unknown
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
}

/**
 * Type-erased activity shape that also exposes success and error schemas for
 * derived flow APIs.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyWithProps {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly executeEncoded: Effect.Effect<any, any, any>
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly metadata: unknown
  readonly retryPolicy: RetryPolicy.RetryPolicy | undefined
}

/**
 * Creates a flow activity from an effect, using the provided schemas to
 * encode successes and failures for durable execution.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  R,
  Success extends Schema.Constraint = Schema.Void,
  Error extends Schema.Constraint = Schema.Never
>(options: {
  readonly name: string
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  readonly execute: Effect.Effect<Success["Type"], Error["Type"], R>
  readonly tier?: Tier | undefined
  readonly idempotencyKey?: IdempotencyKey | undefined
  readonly metadata?: unknown
  readonly interruptRetryPolicy?: Schedule.Schedule<any, unknown> | undefined
  readonly retryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly annotations?: Context.Context<never> | undefined
}): Activity<Success, Error, Exclude<R, FlowInstance | FlowEngine | Scope>> => {
  const successSchema = options.success ?? (Schema.Void as any as Success)
  const errorSchema = options.error ?? (Schema.Never as any as Error)
  const successSchemaJson = Schema.toCodecJson(successSchema)
  const errorSchemaJson = Schema.toCodecJson(errorSchema)
  // oxlint-disable-next-line prefer-const
  let execute!: Effect.Effect<Success["Type"], Error["Type"], any>
  const executeWithInfraRetry = retryInfraInterrupt(
    options.name,
    options.interruptRetryPolicy
  )(options.execute)
  const self: Activity<Success, Error, Exclude<R, FlowInstance | FlowEngine>> = {
    ...Effectable.Prototype<Activity<Success, Error, R>>({
      label: "Activity",
      evaluate(_) {
        return execute
      }
    }),
    [TypeId]: TypeId,
    name: options.name,
    successSchema,
    errorSchema,
    exitSchema: Schema.Exit(successSchemaJson, errorSchemaJson, Schema.Defect()),
    exitSchemaPartial: Schema.Exit(successSchemaJson, errorSchemaJson, Schema.Unknown),
    annotations: options.annotations ?? Context.empty(),
    tier: options.tier ?? "sealed",
    idempotencyKey: options.idempotencyKey,
    metadata: options.metadata,
    retryPolicy: options.retryPolicy,
    annotate(tag: Context.Key<any, any>, value: any) {
      return make({
        ...options,
        annotations: Context.add(self.annotations, tag, value)
      })
    },
    annotateMerge(context: Context.Context<any>) {
      return make({
        ...options,
        annotations: Context.merge(self.annotations, context)
      })
    },
    execute: executeWithInfraRetry,
    executeEncoded: Effect.matchEffect(executeWithInfraRetry, {
      onFailure: (error) => Effect.flatMap(Effect.orDie(Schema.encodeEffect(errorSchemaJson)(error)), Effect.fail),
      onSuccess: (value) => Effect.orDie(Schema.encodeEffect(successSchemaJson)(value))
    })
  } as any
  execute = makeExecute(self)
  return self
}

const isInfraInterrupt = Predicate.isTagged("@smithers/engine/InfraInterrupt")

const retryInfraInterrupt = (
  name: string,
  policy: Schedule.Schedule<any, unknown> | undefined
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  policy === undefined
    ? effect
    : effect.pipe(
      Effect.retry({
        schedule: policy,
        while: isInfraInterrupt
      }),
      Effect.catch((error) =>
        isInfraInterrupt(error)
          ? Effect.die(`Activity "${name}" infrastructure interrupt retry attempts exhausted`)
          : Effect.fail(error)
      )
    )

/**
 * The resolved environment a sealed activity's content key is computed under.
 *
 * `layers` names the service implementations the activity body actually runs
 * against (a model, a host, a sandbox) and `capabilities` the permission set
 * it was granted. Both are mandatory content-key material — the Step Keys
 * spec calls layers "the easiest part to forget and the most painful to
 * discover" — because a sealed hard-boundary activity is cached across runs:
 * without them, swapping `Model=sonnet` for `Model=opus` or attenuating a
 * capability leaves the digest byte-identical and serves the stale result
 * (issue #75).
 *
 * @category Idempotency
 * @since 0.1.0
 */
export interface ContentEnvironment {
  readonly layers: ReadonlyArray<string>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
}

/**
 * Context reference carrying the environment folded into every sealed
 * content key.
 *
 * The composition that wires the model, host, and permission layers declares
 * it; the engine cannot resolve layer identity on its own. The default is the
 * empty environment, which is the honest statement that nothing has been
 * declared — a composition that caches sealed activities across runs is
 * expected to declare one.
 *
 * @category Idempotency
 * @since 0.1.0
 */
export const CurrentContentEnvironment = Context.Reference<ContentEnvironment>(
  "flows/engine/Activity/CurrentContentEnvironment",
  { defaultValue: (): ContentEnvironment => ({ layers: [], capabilities: {} }) }
)

/**
 * The ordinal slots a retry sequence shares across its attempts, keyed by
 * allocation scope.
 *
 * `Activity.retry` cannot allocate ordinals itself — allocation is scoped by
 * activity identity and only the engine knows which activity is being
 * dispatched (issue #73) — so it provides an empty map the engine fills per
 * scope on the first attempt and reads back on every later one. The map is
 * scope-keyed rather than a single value because one retry block may
 * dispatch several distinct activities; a shared unkeyed slot handed the
 * first activity's ordinal to every later one, silently skipping their own
 * name-scoped counters and aliasing a later independent dispatch onto an
 * in-block key (issue #84).
 *
 * @category Attempts
 * @since 0.1.0
 */
export interface OrdinalSlot {
  readonly values: Map<string, number>
}

/**
 * Context reference carrying the ordinal slot of the enclosing
 * `Activity.retry` sequence, when present.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const CurrentOrdinal = Context.Reference<OrdinalSlot | undefined>(
  "flows/engine/Activity/CurrentOrdinal",
  { defaultValue: () => undefined }
)

/**
 * Retries an effect with `Effect.retry` while updating `CurrentAttempt` for
 * each attempt.
 *
 * @category error handling
 * @since 4.0.0
 */
export const retry: {
  <E, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(
    options: O
  ): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Retry.Return<R, E, A, O>
  <A, E, R, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(
    self: Effect.Effect<A, E, R>,
    options: O
  ): Effect.Retry.Return<R, E, A, O>
} = dual(
  2,
  (effect: Effect.Effect<any, any, any>, options: {}) =>
    Effect.suspend(() => {
      let attempt = 1
      // One slot map for the whole retry sequence: the engine fills each
      // activity's scope with the ordinal it allocates on the first attempt,
      // and every later attempt of the same sequence reuses those ordinals
      // (issues #73, #84).
      const slot: OrdinalSlot = { values: new Map() }
      return Effect.suspend(() =>
        effect.pipe(
          Effect.provideService(CurrentAttempt, attempt++),
          Effect.provideService(CurrentOrdinal, slot)
        )
      ).pipe(Effect.retry(options))
    })
)

/**
 * Context reference containing the current activity retry attempt, defaulting
 * to `1`.
 *
 * @category Attempts
 * @since 4.0.0
 */
export const CurrentAttempt = Context.Reference<number>(
  "effect/flow/Activity/CurrentAttempt",
  { defaultValue: () => 1 }
)

/**
 * Computes a run-local ordinal key for an internal durable operation.
 *
 * The `name` remains diagnostic only and never contributes to identity.
 *
 * @category Idempotency
 * @since 4.0.0
 */
export const idempotencyKey: (
  name: string,
  options?: {
    readonly includeAttempt?: boolean | undefined
    readonly parentScope?: string | undefined
  } | undefined
) => Effect.Effect<string, never, FlowInstance> =
  // Untraced because activity-key allocation is on every activity attempt.
  Effect.fnUntraced(function*(_name: string, options?: {
    readonly includeAttempt?: boolean | undefined
    readonly parentScope?: string | undefined
  }) {
    const instance = yield* InstanceTag
    const attempt = yield* CurrentAttempt
    // Internal durable operations keep their own single counter: their
    // identity is deliberately name-free (the name is diagnostic only), so
    // they are ordered by allocation within the run.
    const ordinal = instance.activityState.nextOrdinal("idempotency")
    return Result.getOrThrow(StepKey.ordinal({
      runId: instance.executionId,
      ordinal,
      tier: "unsealed",
      ...(options?.parentScope !== undefined
        ? { parentScope: options.parentScope }
        : options?.includeAttempt
        ? { parentScope: `attempt:${attempt}` }
        : {})
    }))
  })

/**
 * Runs a non-empty collection of activities as a durable race and returns the
 * first completed success or failure using unioned success and error schemas.
 *
 * @category racing
 * @since 4.0.0
 */
export const raceAll = <const Activities extends NonEmptyReadonlyArray<Any>>(
  name: string,
  activities: Activities
): Effect.Effect<
  Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _A["Type"] : never,
  Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _E["Type"] : never,
  | (Activities[number] extends Activity<infer Success, infer Error, infer R>
    ? Success["DecodingServices"] | Error["DecodingServices"] | R
    : never)
  | FlowEngine
  | FlowInstance
> =>
  DurableDeferred.raceAll({
    name: `Activity/${name}`,
    success: Schema.Union(
      activities.map((activity) => (activity as any).successSchema)
    ),
    error: Schema.Union(
      activities.map((activity) => (activity as any).errorSchema)
    ),
    effects: activities.map((activity) => (activity as any)) as any
  }) as any

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

const EngineTag = Context.Service<FlowEngine, FlowEngine["Service"]>(
  "effect/flow/FlowEngine" satisfies typeof FlowEngine.key
)
const InstanceTag = Context.Service<FlowInstance, FlowInstance["Service"]>(
  "effect/flow/FlowEngine/FlowInstance" satisfies typeof FlowInstance.key
)

// Untraced because activity execution is retried in the flow hot path.
const makeExecute = Effect.fnUntraced(function*<
  R,
  Success extends Schema.Constraint = typeof Schema.Void,
  Error extends Schema.Constraint = typeof Schema.Never
>(activity: Activity<Success, Error, R>) {
  const engine = yield* EngineTag
  const instance = yield* InstanceTag
  const attempt = yield* CurrentAttempt
  yield* Effect.annotateCurrentSpan({ executionId: instance.executionId })
  const result = yield* Flow.wrapActivityResult(
    engine.activityExecute(activity, attempt),
    (_) => _._tag === "Suspended"
  )
  if (result._tag === "Suspended") {
    return yield* Flow.suspend(instance)
  }
  return yield* result.exit
}, (effect, activity) =>
  Effect.withSpan(effect, activity.name, {
    captureStackTrace: false
  }))
