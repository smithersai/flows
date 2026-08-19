/**
 * Interactive Vitest watch sessions.
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
 * Attributes for {@link VitestWatch}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `config` path resolves from `cwd` when the tool
 * runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  environment: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
})

/**
 * Attributes for {@link VitestWatch}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** The declaration form. {@link VitestWatch} adds the path form to it. */
const definition = Target.make("VitestWatch", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) => {
    const manager = PackageManager.registeredToolchain().packageManager
    return Target.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(manager, [
        "vitest",
        "watch",
        ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
        "--environment",
        attrs.environment
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
 * Expands a config-file path into the conventional watch declaration.
 */
const fromConfigPath = (path: string): Parameters<typeof definition>[0] => {
  const site = configSite(path)
  return {
    tests: [Input.glob("test/**/*.test.ts")],
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    config: Input.file(site.name),
    environment: "node",
    cwd: site.cwd
  }
}

/**
 * Plans an interactive Vitest watch session.
 *
 * The body records one {@link Exec.Exec} node that runs `vitest watch` from
 * `cwd` with the declared config and environment. The spawn is a
 * pass-through: the node succeeds when the session exits cleanly and
 * interrupting the fiber kills the process. Inputs and dependency keys
 * describe startup invalidation, but the target is non-cacheable because it is
 * a long-lived process. This follows Vitest watch mode and tevm's `test:watch`
 * target. Executing the plan requires {@link Exec.ExecLive}.
 *
 * `VitestWatch("packages/plan/vitest.config.ts")` is the path form. It runs in
 * the directory that holds the named file and expands to the same declared
 * inputs `StandardPackage` supplies to its test target: the conventional test
 * glob as tests, the conventional source glob as sources, and the named file
 * as the config.
 *
 * The config file is not parsed. The globs come from the repository
 * convention, not from vitest's own `include` patterns.
 *
 * @category targets
 * @since 0.1.0
 */
export const VitestWatch = Object.assign(
  (attrs: Parameters<typeof definition>[0] | string) =>
    definition(typeof attrs === "string" ? fromConfigPath(attrs) : attrs),
  definition
)
