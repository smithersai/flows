// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Constructs executable durable activity values.
 *
 * @since 4.0.0
 */
import * as Node from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Scope } from "effect/Scope"
import * as Flow from "../Flow/index.ts"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { Activity, Declared, IdempotencyKey, Tier } from "./Activity.ts"
import { CurrentAttempt } from "./Context.ts"
import { type Implementation, Implementations } from "./Implementations.ts"
import { TypeId } from "./TypeId.ts"

/**
 * Creates a flow activity from an effect, using the provided schemas to
 * encode successes and failures for durable execution.
 *
 * @category constructors
 * @since 4.0.0
 */
const makeInline = <
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
}): Activity<Success, Error, Exclude<R, FlowInstance | FlowRuntime | Scope>> => {
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
  const self: Activity<Success, Error, Exclude<R, FlowInstance | FlowRuntime>> = {
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
      return makeInline({
        ...options,
        annotations: Context.add(self.annotations, tag, value)
      })
    },
    annotateMerge(context: Context.Context<any>) {
      return makeInline({
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

const makeDeclared = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(tag: Tag, options: {
  readonly payload: Payload
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  readonly tier?: Tier | undefined
  readonly idempotencyKey?: IdempotencyKey | undefined
  readonly annotations?: Context.Context<never> | undefined
}): Declared<
  Tag,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
> => {
  type PayloadSchema = Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload
  const payloadSchema = (Schema.isSchema(options.payload)
    ? options.payload
    : Schema.Struct(options.payload)) as PayloadSchema
  const successSchema = options.success ?? (Schema.Void as unknown as Success)
  const errorSchema = options.error ?? (Schema.Never as unknown as Error)
  const annotations = options.annotations ?? Context.empty()
  const self: Declared<Tag, PayloadSchema, Success, Error> = {
    [TypeId]: TypeId,
    name: tag,
    payloadSchema,
    successSchema,
    errorSchema,
    tier: options.tier ?? "sealed",
    idempotencyKey: options.idempotencyKey,
    annotations,
    annotate(key: Context.Key<any, any>, value: any) {
      return makeDeclared(tag, {
        ...options,
        annotations: Context.add(annotations, key, value)
      })
    },
    annotateMerge(context: Context.Context<any>) {
      return makeDeclared(tag, {
        ...options,
        annotations: Context.merge(annotations, context)
      })
    },
    call(payload) {
      return Node.activityCall<Success["Type"], Error["Type"]>(self, tag, payload)
    },
    toLayer(execute) {
      const registration = Flow.make(tag, {
        payload: payloadSchema,
        success: successSchema,
        error: errorSchema,
        annotations
      })
      const activity = (payload: PayloadSchema["Type"]) =>
        makeInline({
          name: tag,
          success: successSchema,
          error: errorSchema,
          tier: self.tier,
          idempotencyKey: self.idempotencyKey,
          annotations,
          execute: execute(payload)
        })
      // A driver that expands a body reaches the implementation by tag rather
      // than by invoking the flow this registers, so the same implementation is
      // filed in the table when a composition wired one up. The table is
      // optional on purpose: a composition that only executes registered
      // handlers has no use for it, and requiring it would change what every
      // existing `toLayer` call site must provide.
      const file = Layer.effectDiscard(Effect.gen(function*() {
        const table = yield* Effect.serviceOption(Implementations)
        if (Option.isNone(table)) return
        const services = yield* Effect.context<never>()
        // The captured context is what the runtime's own `register` captures
        // for the handler path: the services the implementation was wired with,
        // overridable by whatever the run provides on top of them.
        const provided = (payload: unknown) =>
          Effect.flatMap(
            // A driver assembles this payload from plan values rather than from
            // a typed call site, so the declaration validates it exactly as
            // `Flow.execute` validates a caller's. The cast is the erasure that
            // hands an unknown to the constructor; `makeEffect` is what decides
            // whether it was one.
            Effect.orDie(payloadSchema.makeEffect(payload as never)),
            (decoded) => activity(decoded)
          ).pipe(Effect.updateContext((input) => Context.merge(services, input) as Context.Context<any>))
        yield* table.value.add({ name: tag, activity: provided as Implementation["activity"] })
      }))
      return Layer.merge(registration.toLayer(activity), file)
    }
  }
  return self
}

/**
 * Creates either an inline executable activity or a named activity
 * declaration, selected by whether the first argument is a string.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: {
  <
    const Tag extends string,
    Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
    Success extends Schema.Top = Schema.Void,
    Error extends Schema.Top = Schema.Never
  >(tag: Tag, options: {
    readonly payload: Payload
    readonly success?: Success | undefined
    readonly error?: Error | undefined
    readonly tier?: Tier | undefined
    readonly idempotencyKey?: IdempotencyKey | undefined
    readonly annotations?: Context.Context<never> | undefined
  }): Declared<
    Tag,
    Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
    Success,
    Error
  >
  <
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
  }): Activity<Success, Error, Exclude<R, FlowInstance | FlowRuntime | Scope>>
} = ((first: string | Parameters<typeof makeInline>[0], second?: object) =>
  typeof first === "string"
    ? makeDeclared(first, second as Parameters<typeof makeDeclared>[1])
    : makeInline(first)) as any

const isInfraInterrupt = Predicate.isTagged("@smthrs/engine/InfraInterrupt")

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

// Untraced because activity execution is retried in the flow hot path.
const makeExecute = Effect.fnUntraced(function*<
  R,
  Success extends Schema.Constraint = typeof Schema.Void,
  Error extends Schema.Constraint = typeof Schema.Never
>(activity: Activity<Success, Error, R>) {
  const engine = yield* FlowRuntime
  const instance = yield* FlowInstance
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
