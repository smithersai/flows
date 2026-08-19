/**
 * ESLint checks.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

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
  deps: Schema.Array(Target.Target),
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

/** The declaration form. {@link EsLint} adds the path form to it. */
const definition = Target.make("EsLint", {
  attrs: Attrs,
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) => {
    const config = attrs.configs[0]
    const manager = PackageManager.registeredToolchain().packageManager
    return Target.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(manager, [
        "eslint",
        ...(config === undefined ? [] : ["--config", config.path]),
        "--max-warnings",
        String(attrs.maxWarnings),
        ...(attrs.fix ? ["--fix"] : []),
        ...lintPatterns(attrs.sources)
      ])
    })
  }
})

/**
 * Splits a workspace-relative config path into the directory the tool runs in
 * and the file name that resolves from it.
 */
const configSite = (path: string): { readonly cwd: string; readonly name: string } => {
  const slash = path.lastIndexOf("/")
  return slash === -1
    ? { cwd: ".", name: path }
    : { cwd: path.slice(0, slash), name: path.slice(slash + 1) }
}

/**
 * Expands a config-file path into the conventional ESLint declaration.
 */
const fromConfigPath = (path: string): Parameters<typeof definition>[0] => {
  const site = configSite(path)
  return {
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    configs: [Input.file(site.name), Input.file("//eslint.jsdoc.js")],
    maxWarnings: 0,
    fix: false,
    cwd: site.cwd
  }
}

/**
 * Plans ESLint over declared source sets.
 *
 * The body records one {@link Exec.Exec} run of `eslint` from `cwd` with the
 * first declared flat config passed as `--config`, the warning budget as
 * `--max-warnings`, and `--fix` when fix mode is enabled. Every further
 * config is declared key material for files the flat config imports. Tools
 * resolve through the manager the workspace registered in `WORKSPACE.ts`.
 * Key material contains source and flat-config digests, dependency keys,
 * warning policy, and fix mode. The target remains non-cacheable in either
 * mode until the external ESLint toolchain is complete key material. The
 * target follows ESLint flat-config prior art and the flows repo's current
 * package lint scripts. Executing the plan requires {@link Exec.ExecLive}.
 *
 * `EsLint("packages/plan/eslint.config.js")` is the path form. It runs in the
 * directory that holds the named file and expands to the same declared inputs
 * `StandardPackage` supplies: the conventional source glob as sources, and the
 * named flat config followed by the root `//eslint.jsdoc.js`.
 *
 * The flat config is not parsed. The source glob comes from the repository
 * convention, not from the config's own `files` patterns, so a package that
 * lints more declares it with the inline form.
 *
 * @category targets
 * @since 0.1.0
 */
export const EsLint = Object.assign(
  (attrs: Parameters<typeof definition>[0] | string) =>
    definition(typeof attrs === "string" ? fromConfigPath(attrs) : attrs),
  definition
)
