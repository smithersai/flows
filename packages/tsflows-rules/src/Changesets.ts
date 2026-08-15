/**
 * Changesets status and version operations.
 *
 * This module also declares the irreversible exec action shared by the
 * release rules that mutate external or working-tree state.
 *
 * @since 0.1.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow-next"
import type * as Node from "@smthrs/plan-next/Node"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Rule from "./Rule.ts"

/**
 * The irreversible variant of the shared exec action.
 *
 * It carries the same payload, result, and error as {@link Exec.Exec} but is
 * declared at the `irreversible` tier, so the engine refuses to retry it
 * blindly and no verification, replay, or cache-population path may execute
 * it. Release rules use it for every run that mutates manifests or external
 * registries.
 *
 * @category actions
 * @since 0.1.0
 */
export const ExecIrreversible = Action.make("tsflows-rules/exec-irreversible", {
  payload: Exec.Payload,
  success: Exec.Result,
  error: Exec.ExecError,
  tier: "irreversible"
})

/**
 * Implements {@link ExecIrreversible} with `node:child_process` spawn.
 *
 * It delegates to the shared confined exec runner, so environment scrubbing,
 * bounded output capture, and process-group interruption match sealed execs.
 *
 * @category layers
 * @since 0.1.0
 */
export const ExecIrreversibleLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<Action.Requirement<"tsflows-rules/exec-irreversible">, never, FlowRuntime.FlowRuntime> =>
  ExecIrreversible.toLayer((payload) => Exec.run(options, payload))

/**
 * Attributes for {@link Changesets}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  operation: Schema.Literals(["status", "version"]),
  changesets: Schema.Array(Input.Declared),
  config: Input.File,
  rootPackageJson: Input.File,
  lockfile: Input.File,
  deps: Schema.Array(Rule.Target),
  since: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * Attributes for {@link Changesets}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans Changesets status or versioning at the workspace root.
 *
 * The status operation runs `pnpm exec changeset status`, with `--since` when
 * a base revision is declared, through the shared sealed exec action. The
 * version operation runs `pnpm exec changeset version` through
 * {@link ExecIrreversible}: it mutates manifests and changelogs, so it is
 * irreversible tier, never cacheable, and never run by any verification.
 * Both operations are direct `run` targets. Version also has a `run` verb
 * gate, so the planner rejects it when any build, test, or lint graph reaches
 * it transitively. Status has no gate and remains safe to inspect from a lint
 * graph. Key material contains changeset, config, manifest, and lockfile
 * digests, dependency keys, operation, and base revision. Release order is
 * status, version, build and package lint, npm publish, then JSR publish. This
 * follows Changesets and tevm's release scripts. Executing the plan requires
 * {@link Exec.ExecLive} for status and
 * {@link ExecIrreversibleLive} for version.
 *
 * @category rules
 * @since 0.1.0
 */
export const Changesets = Rule.make("Changesets", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  verbGate: (attrs) => attrs.operation === "version" ? ["run"] : undefined,
  implementation: (
    attrs
  ): Node.Node<
    Exec.Result,
    Exec.ExecError,
    Action.Requirement<"tsflows-rules/exec"> | Action.Requirement<"tsflows-rules/exec-irreversible">
  > =>
    attrs.operation === "version"
      ? ExecIrreversible.call({
        cwd: ".",
        argv: ["pnpm", "exec", "changeset", "version"]
      })
      : Rule.runTool({
        cwd: ".",
        argv: attrs.since === null
          ? ["pnpm", "exec", "changeset", "status"]
          : ["pnpm", "exec", "changeset", "status", "--since", attrs.since]
      })
})
