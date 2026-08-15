/**
 * ESLint checks.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Rule from "./Rule.ts"

/**
 * Attributes for {@link EsLint}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. Config paths and source patterns resolve from `cwd`
 * when the tool runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Rule.Target),
  configs: Schema.Array(Input.File),
  maxWarnings: Schema.Number,
  fix: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link EsLint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Reduces declared sources to the patterns ESLint lints.
 *
 * ESLint expands glob patterns itself, so a glob passes through as written,
 * a file contributes its path, and a git diff contributes nothing.
 */
const lintPatterns = (sources: ReadonlyArray<Input.Declared>): ReadonlyArray<string> =>
  sources.flatMap((source) => source._tag === "File" ? [source.path] : source._tag === "Glob" ? [source.pattern] : [])

/**
 * Plans ESLint over declared source sets.
 *
 * The body records one {@link Exec.Exec} run of `eslint` from `cwd` with the
 * first declared flat config passed as `--config`, the warning budget as
 * `--max-warnings`, and `--fix` when fix mode is enabled. Every further
 * config is declared key material for files the flat config imports. Tools
 * resolve through `pnpm exec`, matching the pnpm workspace install target.
 * Key material contains source and flat-config digests, dependency keys,
 * warning policy, and fix mode; fix mode is non-cacheable. The rule follows
 * ESLint flat-config prior art and the flows repo's current package lint
 * scripts. Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category rules
 * @since 0.1.0
 */
export const EsLint = Rule.make("EsLint", {
  attrs: Attrs,
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) => {
    const config = attrs.configs[0]
    return Rule.runTool({
      cwd: attrs.cwd,
      argv: [
        "pnpm",
        "exec",
        "eslint",
        ...(config === undefined ? [] : ["--config", config.path]),
        "--max-warnings",
        String(attrs.maxWarnings),
        ...(attrs.fix ? ["--fix"] : []),
        ...lintPatterns(attrs.sources)
      ]
    })
  }
})
