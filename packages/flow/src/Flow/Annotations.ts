// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Execution policies attached to flow definitions through Effect context.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import { constFalse, constTrue } from "effect/Function"
import * as Schema from "effect/Schema"

/**
 * Declared filesystem effects copied from the plan node effect contract.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Effects = Schema.Struct({
  reads: Schema.Array(Schema.String),
  writes: Schema.Array(Schema.String),
  boundaryMode: Schema.Literals(["hard", "expected"])
})

/**
 * The value form of {@link Effects}.
 *
 * @category models
 * @since 0.1.0
 */
export type Effects = typeof Effects.Type

/**
 * Schema-encodable placement directive retained opaquely until planning.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PlacementDirective = Schema.Unknown

/**
 * The value form of {@link PlacementDirective}.
 *
 * @category models
 * @since 0.1.0
 */
export type PlacementDirective = typeof PlacementDirective.Type

/**
 * Capability names a flow may require, defaulting to none.
 *
 * @category annotations
 * @since 0.1.0
 */
export const Capabilities = Context.Reference<ReadonlyArray<string>>(
  "@smthrs/flow-next/Flow/Capabilities",
  { defaultValue: () => [] }
)

/**
 * Required annotation key for a flow's declared filesystem effects.
 *
 * @category annotations
 * @since 0.1.0
 */
export const EffectsDeclaration = Context.Service<Effects>("@smthrs/flow-next/Flow/EffectsDeclaration")

/**
 * Required annotation key for a flow's schema-encodable placement directive.
 *
 * @category annotations
 * @since 0.1.0
 */
export const Placement = Context.Service<PlacementDirective>("@smthrs/flow-next/Flow/Placement")

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
