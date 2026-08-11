// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Execution policies attached to flow definitions through Effect context.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import { constFalse, constTrue } from "effect/Function"

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
