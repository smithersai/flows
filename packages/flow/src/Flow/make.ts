// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Constructs executable flow declarations from schema and policy data.
 *
 * @since 4.0.0
 */
import { Sha256 } from "@smthrs/crypto"
import * as Node from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import { BodyDefinesBehavior } from "./BodyDefinesBehavior.ts"
import { ExecutionIdRequired } from "./ExecutionIdRequired.ts"
import type { AnyStructSchema, AnyWithProps, Bodied, Flow } from "./Flow.ts"
import type { To } from "./Outcome.ts"
import { withRollback } from "./Runtime.ts"
import { TypeId } from "./TypeId.ts"

const makeExecutionIdFromPayload = (
  self: AnyWithProps,
  payload: unknown
): Effect.Effect<string, never, Crypto.Crypto> => {
  const idempotencyKey = self.idempotencyKey
  return idempotencyKey === undefined
    ? Effect.die(new ExecutionIdRequired({ flowName: self._tag }))
    : Schema.decodeUnknownEffect(Sha256)(`${self._tag}-${idempotencyKey(payload)}`).pipe(Effect.orDie)
}

const resolveExecutionId = (
  self: AnyWithProps,
  payload: unknown,
  executionId: string | undefined
): Effect.Effect<string, never, Crypto.Crypto> =>
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
      body: this.body,
      idempotencyKey: this.idempotencyKey,
      suspendedRetryPolicy: this.suspendedRetryPolicy
    })
  },
  annotateMerge(this: AnyWithProps, context: Context.Context<any>) {
    return makeProto({
      _tag: this._tag,
      payloadSchema: this.payloadSchema,
      successSchema: this.successSchema,
      errorSchema: this.errorSchema,
      annotations: Context.merge(this.annotations, context),
      body: this.body,
      idempotencyKey: this.idempotencyKey,
      suspendedRetryPolicy: this.suspendedRetryPolicy
    })
  },
  call(this: AnyWithProps, payload: unknown) {
    return Node.flowCall(this, this._tag, "inline", payload)
  },
  to(this: AnyWithProps, payload: unknown): Node.Node<To<unknown>> {
    return Node.succeed({
      _tag: "To",
      flow: this._tag,
      payload
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
          Effect.flatMap(FlowRuntime, (engine) =>
            Effect.andThen(
              Effect.annotateCurrentSpan({ executionId }),
              engine.execute(this as any, {
                executionId,
                payload,
                discard: opts?.discard,
                suspendedRetryPolicy: this.suspendedRetryPolicy
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
    return Effect.flatMap(FlowRuntime, (engine) => engine.poll(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.poll`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  interrupt(this: AnyWithProps, executionId: string) {
    return Effect.flatMap(FlowRuntime, (engine) => engine.interrupt(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.interrupt`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  resume(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top>, executionId: string) {
    return Effect.flatMap(FlowRuntime, (engine) => engine.resume(this, executionId)).pipe(
      Effect.withSpan(`${this._tag}.resume`, { attributes: { executionId } }, { captureStackTrace: false })
    )
  },
  toLayer(this: Flow<string, AnyStructSchema, Schema.Top, Schema.Top>, execute: any) {
    // One behavior per flow. The type of a bodied flow already refuses this
    // call; the defect is what a JavaScript caller, or an erased `Flow.Any`,
    // gets instead of a flow that plans one way and runs another.
    return this.body === undefined
      ? Layer.effectDiscard(
        Effect.flatMap(FlowRuntime, (engine) => engine.register(this, execute))
      )
      : Layer.effectDiscard(Effect.die(
        new BodyDefinesBehavior({
          flowName: this._tag,
          message: `Flow "${this._tag}" declares a body, so its behavior is that body. ` +
            `Register it with Interpreter.layer(${this._tag}) instead of toLayer, or drop the body and keep the handler.`
        })
      ))
  },
  executionId(this: AnyWithProps, payload: any) {
    return Effect.flatMap(
      Effect.orDie(this.payloadSchema.makeEffect(payload)),
      (payload) => makeExecutionIdFromPayload(this, payload)
    )
  },
  withRollback: ((...args: ReadonlyArray<any>) => (withRollback as any)(...args))
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
  readonly body?: ((payload: Payload["Type"]) => Node.Node<unknown, unknown>) | undefined
  readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
}): Flow<Tag, Payload, Success, Error> => {
  function Flow() {}
  Object.setPrototypeOf(Flow, Proto)
  Object.assign(Flow, options)
  return Flow as any
}

/**
 * The declaration data every flow takes, whether or not it has a body.
 *
 * @private
 */
interface MakeOptions<
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
> {
  readonly payload: Payload
  readonly idempotencyKey?:
    | ((
      payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload>
        : Payload["Type"]
    ) => string)
    | undefined
  readonly success?: Success
  readonly error?: Error
  readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  readonly annotations?: Context.Context<never>
}

/**
 * The pure plan-time body, typed with the decoded payload.
 *
 * @private
 */
type Body<Payload extends Schema.Struct.Fields | AnyStructSchema> = (
  payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload> : Payload["Type"]
) => Node.Node<unknown, unknown>

/**
 * The payload schema a declaration's `payload` field stands for.
 *
 * @private
 */
type PayloadSchemaOf<Payload extends Schema.Struct.Fields | AnyStructSchema> = Payload extends Schema.Struct.Fields
  ? Schema.Struct<Payload>
  : Payload

/**
 * Creates a durable flow definition with schemas, annotations, and either
 * caller-selected execution IDs or opt-in deterministic IDs derived from the
 * flow tag and idempotency key.
 *
 * Declaring a `body` answers with {@link module:Flow.Bodied}: the body is then
 * the flow's one behavior, so the returned declaration has no `toLayer` to
 * attach a second one with.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: {
  <
    const Tag extends string,
    Payload extends Schema.Struct.Fields | AnyStructSchema,
    Success extends Schema.Top = Schema.Void,
    Error extends Schema.Top = Schema.Never
  >(
    tag: Tag,
    options: MakeOptions<Payload, Success, Error> & { readonly body: Body<Payload> }
  ): Bodied<Tag, PayloadSchemaOf<Payload>, Success, Error>
  <
    const Tag extends string,
    Payload extends Schema.Struct.Fields | AnyStructSchema,
    Success extends Schema.Top = Schema.Void,
    Error extends Schema.Top = Schema.Never
  >(
    tag: Tag,
    options: MakeOptions<Payload, Success, Error> & { readonly body?: undefined }
  ): Flow<Tag, PayloadSchemaOf<Payload>, Success, Error>
} = (<
  const Tag extends string,
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(tag: Tag, options: MakeOptions<Payload, Success, Error> & { readonly body?: Body<Payload> | undefined }) =>
  makeProto<Tag, PayloadSchemaOf<Payload>, Success, Error>({
    _tag: tag,
    payloadSchema: (Schema.isSchema(options.payload)
      ? options.payload
      : Schema.Struct(options.payload as any)) as PayloadSchemaOf<Payload>,
    successSchema: options.success ?? (Schema.Void as any),
    errorSchema: options.error ?? (Schema.Never as any),
    annotations: options.annotations ?? Context.empty(),
    body: options.body as
      | ((payload: PayloadSchemaOf<Payload>["Type"]) => Node.Node<unknown, unknown>)
      | undefined,
    idempotencyKey: options.idempotencyKey as any,
    suspendedRetryPolicy: options.suspendedRetryPolicy
  })) as typeof make
