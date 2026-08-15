import * as Schema from "effect/Schema"

/** Stable evaluation failure codes. @since 0.1.0 @category models */
export const EvalErrorCode = Schema.Literals(["invalid_suite", "invalid_baseline", "missing_ground_truth", "executor"])

/** Stable evaluation failure code. @since 0.1.0 @category models */
export type EvalErrorCode = typeof EvalErrorCode.Type

/** A typed failure raised while loading or executing an evaluation. @since 0.1.0 @category errors */
export class EvalError extends Schema.TaggedError<EvalError>()("flows/evals/EvalError", {
  code: EvalErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
