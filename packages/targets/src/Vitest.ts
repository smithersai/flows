/**
 * Non-watch Vitest runs.
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
 * Attributes for {@link Vitest}.
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
  passWithNoTests: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
})

/**
 * Attributes for {@link Vitest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** The declaration form. {@link Vitest} adds the path form to it. */
const definition = Target.make("Vitest", {
  attrs: Attrs,
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => {
    const manager = PackageManager.registeredToolchain().packageManager
    return Target.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(manager, [
        "vitest",
        "run",
        ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
        "--environment",
        attrs.environment,
        ...(attrs.passWithNoTests ? ["--passWithNoTests"] : [])
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
 * Expands a config-file path into the conventional Vitest declaration.
 */
const fromConfigPath = (path: string): Parameters<typeof definition>[0] => {
  const site = configSite(path)
  return {
    tests: [Input.glob("test/**/*")],
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    config: Input.file(site.name),
    environment: "node",
    passWithNoTests: false,
    cwd: site.cwd
  }
}

/**
 * Plans a non-watch `vitest run` test target.
 *
 * The body records one {@link Exec.Exec} node that runs `vitest run` from
 * `cwd` with the declared config, environment, and empty-suite policy. Test,
 * source, and config declarations are the target's inputs, so key material
 * contains their digests plus dependency target keys. This models tevm's
 * `test:run` target and Vitest's deterministic run mode. Executing the plan
 * requires {@link Exec.ExecLive}.
 *
 * `Vitest("packages/plan/vitest.config.ts")` is the path form. It runs in the
 * directory that holds the named file and expands to the same declared inputs
 * the `StandardPackage` macro supplies: the conventional test glob as tests,
 * the conventional source glob as sources, and the named file as the config.
 *
 * The config file is not parsed. The globs come from the repository
 * convention, not from vitest's own `include` patterns, so a package that
 * keeps its tests somewhere else declares them with the inline form.
 *
 * The test glob covers the whole test directory rather than the `.test.ts`
 * spec files alone. Vitest imports harness modules and reads fixtures of any
 * extension, and only a declared read is key material. Because this rule is
 * cacheable, a declaration narrowed to the spec files replays the previous
 * run's green result after a harness or fixture edit.
 *
 * @category targets
 * @since 0.1.0
 */
export const Vitest = Object.assign(
  (attrs: Parameters<typeof definition>[0] | string) =>
    definition(typeof attrs === "string" ? fromConfigPath(attrs) : attrs),
  definition
)
