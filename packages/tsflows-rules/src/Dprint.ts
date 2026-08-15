/**
 * dprint formatting checks.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Rule from "./Rule.ts"

/**
 * Attributes for {@link Dprint}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. `config` is the dprint configuration file; the tool
 * discovers the files it checks from that configuration, so `sources` exists
 * purely as declared key material for the files a formatting verdict depends
 * on.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Rule.Target),
  config: Input.File,
  fix: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Dprint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Checks formatting with `dprint check`, or rewrites it with `dprint fmt`.
 *
 * The plan records one {@link Exec.Exec} run of `dprint` from `cwd` with the
 * declared configuration passed as `--config`, mirroring the repository's
 * package lint scripts (`... && dprint check`). Key material contains the
 * source and configuration digests, dependency keys, and the fix mode. The
 * target remains non-cacheable until the external dprint toolchain is
 * complete key material, matching {@link EsLint}'s posture. Executing the
 * plan requires {@link Exec.ExecLive}.
 *
 * @category rules
 * @since 0.1.0
 */
export const Dprint = Rule.make("Dprint", {
  attrs: Attrs,
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) =>
    Rule.runTool({
      cwd: attrs.cwd,
      argv: [
        "pnpm",
        "exec",
        "dprint",
        attrs.fix ? "fmt" : "check",
        "--config",
        attrs.config.path
      ]
    })
})
