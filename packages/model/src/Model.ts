/** @since 0.1.0 */
import type { GrantStoreError, PermissionDenied, PermissionRequired } from "@smthrs/capability-next/Permission"
import { Context, Effect, Layer, Stream } from "effect"
import type { ModelError } from "./ModelError.ts"
import { ModelError as ModelErrorClass } from "./ModelError.ts"
import type { ModelEvent } from "./ModelEvent.ts"
import type { ModelRequest } from "./ModelRequest.ts"

/**
 * Provider and kernel failures surfaced by a model stream.
 *
 * @category errors
 * @since 0.1.0
 */
export type ModelFailure = ModelError | PermissionRequired | PermissionDenied | GrantStoreError

/** @category services @since 0.1.0 */
export interface Model {
  /** Streams model progress; cancellation is fiber interruption only. */
  readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ModelFailure>
}

/** @category services @since 0.1.0 */
export const Model: Context.Service<Model, Model> = Context.Service("/model/Model")

/** @category constructors @since 0.1.0 */
export const make = (implementation: Model): Model => Model.of(implementation)

/** @category layers @since 0.1.0 */
export const layer = (implementation: Model): Layer.Layer<Model> => Layer.succeed(Model)(make(implementation))

/** @category constructors @since 0.1.0 */
export const makeNoop = (overrides: Partial<Model> = {}): Model =>
  Model.of({
    stream: () =>
      Stream.unwrap(
        Effect.fn("Model.stream")(() =>
          Effect.succeed(
            Stream.fail(new ModelErrorClass({ code: "no_route", message: "no model route in this environment" }))
          )
        )()
      ),
    ...overrides
  })

/** @category layers @since 0.1.0 */
export const layerNoop = (overrides: Partial<Model> = {}): Layer.Layer<Model> =>
  Layer.succeed(Model)(makeNoop(overrides))
