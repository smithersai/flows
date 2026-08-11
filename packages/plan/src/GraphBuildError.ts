/**
 * The refusals a plan-time build raises instead of producing a wrong plan.
 *
 * `docs/specs/Concepts/Unified Flow Authoring.md` requires every one of these
 * to fail LOUDLY at build time: a planned value that was computed on must not
 * bake `NaN` into a plan, an arm that returned something other than a node must
 * not silently vanish from the topology, and a recursive `.call()` must direct
 * the author to `.to()` or `.child()` rather than expanding forever. Each
 * failure therefore names the site (`node` plus the recorded property `path`)
 * and states the fix in `message`, because the author reading it is mid-body
 * and needs the correction, not a classification.
 *
 * The codes are a closed schema literal so a caller can switch on them, and so
 * a new refusal is a deliberate addition rather than a new free-form string.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * The stable code of a build refusal.
 *
 * `planned_value_computed` is a body computing on a step result;
 * `invalid_all_member` is a non-node handed to {@link module:Node.all};
 * `invalid_continuation` is a branch arm or continuation that did not return a
 * node; `recursion_requires_boundary` is a flow calling itself inline, which
 * has to become a trampoline handoff or an explicit child boundary.
 *
 * @since 0.1.0
 * @category schemas
 */
export const GraphBuildErrorCode = Schema.Literals([
  "planned_value_computed",
  "invalid_all_member",
  "invalid_continuation",
  "recursion_requires_boundary"
])

/**
 * The value form of {@link GraphBuildErrorCode}.
 *
 * @since 0.1.0
 * @category models
 */
export type GraphBuildErrorCode = typeof GraphBuildErrorCode.Type

/**
 * A build the planner refuses, naming the site and the fix.
 *
 * `node` is the node reference the failure belongs to — a planned value's
 * origin node, an `all` member name, or a branch arm. `path` is the property
 * path recorded on a planned value before it was misused, empty for every
 * other code.
 *
 * @since 0.1.0
 * @category errors
 */
export class GraphBuildError extends Schema.TaggedErrorClass<GraphBuildError>()("flows/plan/GraphBuildError", {
  code: GraphBuildErrorCode,
  node: Schema.String,
  path: Schema.Array(Schema.String),
  message: Schema.String
}) {}
