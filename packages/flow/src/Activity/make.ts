// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Constructs executable durable activity values.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Effectable from "effect/Effectable"
import * as Predicate from "effect/Predicate"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { Scope } from "effect/Scope"
import * as Flow from "../Flow/index.ts"
import { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { Activity, IdempotencyKey, Tier } from "./Activity.ts"
import { CurrentAttempt } from "./Context.ts"
import { TypeId } from "./TypeId.ts"

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
