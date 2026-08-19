/**
 * Bun test runs.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

const globMagic = /[*?[\]{}!()|@+]/

/**
 * Rejects a junit reporter declaration without the file it writes to.
 * Shared with `BunTestCoverage`, which recomposes these fields and therefore
 * re-applies the check.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reporterRequiresOutfile = Schema.makeFilter(
  (attrs: { readonly reporter: "junit" | null; readonly reporterOutfile: string | null }) =>
    attrs.reporter === null || attrs.reporterOutfile !== null ||
    "reporterOutfile is required when reporter is set: bun's junit reporter writes to a file",
  { title: "reporterOutfileRequired" }
)

/**
 * Attributes for {@link BunTest}.
 *
 * `tests` accepts an explicit ordered file list as well as globs. An explicit
 * list is passed to bun positionally in its declared order, and that order is
 * load-bearing: with `--max-concurrency=1` bun runs the named files in the
 * order given, so a runner that shares process state across files depends on
 * it. A glob entry narrows discovery to its static directory prefix.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `preload` path resolves from `cwd` when the tool
 * runs.
 *
 * `timeoutMs` is bun's per-test timeout, not the process lifetime; the
 * process lifetime keeps the {@link Exec} default. `reporter` is limited to
 * the reporters that write a file, so `reporterOutfile` is required when
 * `reporter` is set.
 *
 * `env` declares the environment variables the tool run needs. It is key
 * material, so a target that reads a variable such as `FC_SEED` declares it
 * here and re-keys when the value changes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  preload: Schema.NullOr(Input.File),
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxConcurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  isolate: Schema.Boolean,
  pathIgnorePatterns: Schema.Array(Schema.NonEmptyString),
  reporter: Schema.NullOr(Schema.Literals(["junit"])),
  reporterOutfile: Schema.NullOr(Schema.NonEmptyString),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  )
}).check(reporterRequiresOutfile)

/**
 * Attributes for {@link BunTest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Reduces declared tests to the positional arguments bun accepts.
 *
 * bun treats a positional argument as a path filter and does not expand glob
 * patterns, so a file contributes its path and a glob contributes its static
 * directory prefix. A git diff or a produced input contributes nothing. With
 * no positional argument bun discovers every test under `cwd`. Entries are
 * never reordered or deduplicated: the declared order reaches the command
 * line unchanged.
 */
const bunPaths = (tests: ReadonlyArray<Input.Declared>): ReadonlyArray<string> => {
  const paths: Array<string> = []
  for (const test of tests) {
    if (test._tag === "File") {
      paths.push(test.path)
      continue
    }
    if (test._tag !== "Glob") continue
    const segments: Array<string> = []
    for (const segment of test.pattern.split("/")) {
      if (globMagic.test(segment)) break
      segments.push(segment)
    }
    const prefix = segments.join("/")
    paths.push(prefix === "" ? "." : prefix)
  }
  return paths
}

/**
 * Builds the `bun test` arguments from decoded attrs at plan time, without
 * the package-manager prefix. `extraFlags` are inserted before the positional
 * test paths so a flag is never mistaken for a path filter.
 *
 * One `--path-ignore-patterns` flag is emitted per pattern because bun parses
 * the flag as a single glob; a comma-joined value would be one pattern that
 * matches nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testArguments = (attrs: Attrs, extraFlags: ReadonlyArray<string> = []): Array<string> => [
  "bun",
  "test",
  ...(attrs.preload === null ? [] : ["--preload", attrs.preload.path]),
  `--timeout=${attrs.timeoutMs}`,
  `--max-concurrency=${attrs.maxConcurrency}`,
  ...(attrs.isolate ? ["--isolate"] : []),
  ...attrs.pathIgnorePatterns.map((pattern) => `--path-ignore-patterns=${pattern}`),
  ...(attrs.reporter === null ? [] : ["--reporter", attrs.reporter]),
  ...(attrs.reporterOutfile === null ? [] : ["--reporter-outfile", attrs.reporterOutfile]),
  ...extraFlags,
  ...bunPaths(attrs.tests)
]

/**
 * Builds the `bun test` argv from decoded attrs at plan time.
 *
 * bun resolves through the manager the workspace registered in
 * `WORKSPACE.ts`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testArgv = (attrs: Attrs): Array<string> => {
  const manager = PackageManager.registeredToolchain().packageManager
  return PackageManager.exec(manager, testArguments(attrs))
}

/**
 * Plans a `bun test` test target.
 *
 * The body records one {@link Exec.Exec} node that runs `bun test` from `cwd`
 * with the declared preload, per-test timeout, concurrency, isolation, ignore
 * patterns, and reporter. Test, source, and preload declarations are the
 * target's inputs, so key material contains their digests plus dependency
 * target keys, the declared environment, and the attrs. The runtime and the
 * package manager are not attrs: the registered toolchain supplies both, and
 * its identity is ambient key material for every target in the workspace.
 * This models the smithers workspace's per-package `bun test` scripts,
 * including the explicitly ordered, preloaded suites. Executing the plan
 * requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const BunTest = Target.make("BunTest", {
  attrs: Attrs,
  kinds: ["test"],
  cache: true,
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Target.runTool({ cwd: attrs.cwd, env: attrs.env, argv: testArgv(attrs) })
})
