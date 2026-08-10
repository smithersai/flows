import * as Schema from "effect/Schema"

/** The versioned state stored for a durable flow run. @since 0.1.0 @category schemas */
export const RunState = Schema.Struct({
  version: Schema.Literal(1),
  flowName: Schema.NonEmptyString,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optionalKey(Schema.NonEmptyString),
  result: Schema.optionalKey(Schema.Unknown),
  cancellation: Schema.optionalKey(Schema.Struct({
    interruptedAtMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
  }))
})

/** The versioned state stored for a durable flow run. @since 0.1.0 @category models */
export type RunState = typeof RunState.Type
