/**
 * Failure raised when a flow that has a body is also handed a handler.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A handler layer was requested for a flow whose behavior is already its
 * `body`.
 *
 * One behavior per flow: `docs/specs/Concepts/Unified Flow Authoring.md` makes
 * a body a FIELD rather than an injectable layer precisely so a flow cannot
 * plan one way and run another, and a second, opaque behavior attached
 * underneath it is that ambiguity by another route. A bodied flow is driven by
 * interpreting its body; work that genuinely wants opaque code is an Activity.
 *
 * @category errors
 * @since 0.1.0
 */
export class BodyDefinesBehavior extends Schema.TaggedErrorClass<BodyDefinesBehavior>()(
  "@smthrs/flow/BodyDefinesBehavior",
  {
    code: Schema.Literal("body_defines_behavior").pipe(
      Schema.withConstructorDefault(Effect.succeed("body_defines_behavior"))
    ),
    flowName: Schema.String,
    message: Schema.String
  }
) {}
