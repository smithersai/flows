// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Defines the schemas and interfaces of a durable activity.
 *
 * @since 4.0.0
 */
import type * as Node from "@smthrs/plan-next/Node"
import type * as Planned from "@smthrs/plan-next/Planned"
import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { Scope } from "effect/Scope"
import type { AnyStructSchema } from "../Flow/Flow.ts"
import type { FlowInstance, FlowRuntime } from "../FlowRuntime/index.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { TypeId } from "./TypeId.ts"

/**
 * The durability and retry semantics of an activity.
 *
 * @category models
 * @since 0.1.0
 */
export const Tier = Schema.Literals(["sealed", "compensable", "irreversible"])

/**
 * The durability and retry semantics of an activity.
 *
 * @category models
 * @since 0.1.0
 */
export type Tier = typeof Tier.Type

/**
 * Schema for caller-declared sealed activity identity.
 *
 * @category models
 * @since 0.1.0
 */
export const IdempotencyKey = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json)
])

/**
 * Caller-declared sealed activity identity.
 *
 * A string is namespaced by the activity declaration. A JSON object is
 * caller-owned and remains stable across activity renames. Runtime
 * environment and filesystem facts are always added by the engine.
 *
 * @category models
 * @since 0.1.0
 */
export type IdempotencyKey = typeof IdempotencyKey.Type

/**
 * Recursively permits planned references wherever a declared activity payload
 * accepts a concrete value.
 *
 * @category models
 * @since 0.1.0
 */
export type PlannedPayload<T> =
  | Planned.Planned<T>
  | ([T] extends [ReadonlyArray<infer Value>] ? ReadonlyArray<PlannedPayload<Value>>
    : [T] extends [object] ? { readonly [Key in keyof T]: PlannedPayload<T[Key]> }
    : T)

/**
 * A named activity declaration whose implementation is supplied separately
 * through a layer and whose calls only add nodes to a plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Declared<
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
> {
  readonly [TypeId]: typeof TypeId
  readonly name: Tag
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly tier: Tier
  readonly idempotencyKey: IdempotencyKey | undefined
  readonly annotations: Context.Context<never>
  annotate<I, S>(key: Context.Key<I, S>, value: S): Declared<Tag, Payload, Success, Error>
  annotateMerge<I>(annotations: Context.Context<I>): Declared<Tag, Payload, Success, Error>
  readonly call: (
    payload: PlannedPayload<Payload["~type.make.in"]>
  ) => Node.Node<Success["Type"], Error["Type"]>
  readonly toLayer: <R>(
    execute: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>
  ) => Layer.Layer<
    never,
    never,
    | FlowRuntime
    | Exclude<R, FlowRuntime | FlowInstance | Scope>
    | Payload["DecodingServices"]
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  >
}

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
    | FlowRuntime
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
    | FlowRuntime
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
    | FlowRuntime
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
