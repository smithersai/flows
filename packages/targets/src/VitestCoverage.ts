/**
 * Vitest coverage runs.
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link VitestCoverage}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `config` path and `reportsDirectory` resolve
 * from `cwd` when the tool runs. `config`, `tests`, and `sources` are declared
 * inputs; `reportsDirectory` stays a string because it declares an output
 * path rather than referencing a file the target reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  provider: Schema.Literals(["v8", "istanbul"]),
  reportsDirectory: Schema.NonEmptyString,
  thresholds: Schema.Struct({
    branches: Schema.Number,
    functions: Schema.Number,
    lines: Schema.Number,
    statements: Schema.Number
  }),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
})

/**
 * Attributes for {@link VitestCoverage}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Result of one coverage run: the exec result plus the directory the run
 * wrote its coverage reports into, relative to `cwd`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CoverageReport = Schema.Struct({
  run: Exec.Result,
  reportsDirectory: Schema.NonEmptyString
})

/**
 * Result of one coverage run.
 *
 * @category models
 * @since 0.1.0
 */
export type CoverageReport = typeof CoverageReport.Type

/** The declaration form. {@link VitestCoverage} adds the path form to it. */
const definition = Target.make("VitestCoverage", {
  attrs: Attrs,
  kinds: ["test"],
  success: CoverageReport,
  error: Exec.ExecError,
  implementation: (attrs) => {
    const manager = PackageManager.registeredToolchain().packageManager
    return Node.all({
      run: Target.runTool({
        cwd: attrs.cwd,
        argv: PackageManager.exec(manager, [
          "vitest",
          "run",
          ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
          "--coverage.enabled=true",
          `--coverage.provider=${attrs.provider}`,
          `--coverage.reportsDirectory=${attrs.reportsDirectory}`,
          `--coverage.thresholds.branches=${attrs.thresholds.branches}`,
          `--coverage.thresholds.functions=${attrs.thresholds.functions}`,
          `--coverage.thresholds.lines=${attrs.thresholds.lines}`,
          `--coverage.thresholds.statements=${attrs.thresholds.statements}`
        ])
      }),
      reportsDirectory: Node.succeed(attrs.reportsDirectory)
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
 * Expands a config-file path into the conventional coverage declaration.
 */
const fromConfigPath = (path: string): Parameters<typeof definition>[0] => {
  const site = configSite(path)
  return {
    tests: [Input.glob("test/**/*.test.ts")],
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    config: Input.file(site.name),
    provider: "v8",
    reportsDirectory: "coverage",
    thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
    cwd: site.cwd
  }
}

/**
 * Plans `vitest run` with coverage and declares the coverage directory
 * output.
 *
 * The body records one {@link Exec.Exec} node that runs `vitest run` from
 * `cwd` with coverage enabled for the declared provider, report directory, and
 * thresholds. The success value carries `reportsDirectory` so downstream
 * targets can consume the written reports. Key material contains test, source,
 * and config digests, dependency keys, coverage provider, report path, and
 * thresholds. This models tevm's `test:coverage` target and Vitest coverage.
 * Executing the plan requires {@link Exec.ExecLive}.
 *
 * `VitestCoverage("packages/plan/vitest.config.ts")` is the path form. It runs
 * in the directory that holds the named file and expands to the same declared
 * inputs `StandardPackage` supplies to its test target: the conventional test
 * glob as tests, the conventional source glob as sources, and the named file
 * as the config. The path form reports coverage without gating on it: every
 * threshold is zero, and a workspace that wants a gate declares it with the
 * inline form.
 *
 * The config file is not parsed. The globs come from the repository
 * convention, not from vitest's own `include` patterns, and the thresholds
 * come from the declaration rather than from the config file's `coverage`
 * block.
 *
 * @category targets
 * @since 0.1.0
 */
export const VitestCoverage = Object.assign(
  (attrs: Parameters<typeof definition>[0] | string) =>
    definition(typeof attrs === "string" ? fromConfigPath(attrs) : attrs),
  definition
)
