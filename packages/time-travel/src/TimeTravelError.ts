import * as Schema from "effect/Schema"
/** @since 0.1.0 @category models */
export const TimeTravelErrorCode = Schema.Literals([
  "busy",
  "live_parent",
  "live_child",
  "not_found",
  "rate_limited",
  "compensation_failed",
  "irreversible",
  "unknown"
])
/** @since 0.1.0 @category models */
export type TimeTravelErrorCode = typeof TimeTravelErrorCode.Type
/** @since 0.1.0 @category errors */
export class TimeTravelError extends Schema.TaggedErrorClass<TimeTravelError>()("flows/time-travel/TimeTravelError", {
  code: TimeTravelErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
/** @since 0.1.0 @category constructors */
export const error = (code: TimeTravelErrorCode, message: string, cause?: unknown): TimeTravelError =>
  new TimeTravelError({ code, message, ...(cause === undefined ? {} : { cause }) })
