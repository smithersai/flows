/**
 * TypeScript semantic checks.
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
 * Attributes for {@link Typecheck}.
 *
 * `cwd` is the workspace-relative package directory `tsc` runs in and
 * defaults to the workspace root, so `tsconfig` stays package-relative.
 *
 * `env` declares the environment variables the tool run needs. It is key
 * material, so a target that reads a variable such as `FC_SEED` declares it
 * here and re-keys when the value changes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  tsconfig: Input.File,
  buildMode: Schema.Boolean,
  incremental: Schema.Boolean,
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Typecheck}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the checking argv from decoded attrs at plan time.
 *
 * `tsc` resolves through the manager the workspace registered in
 * `WORKSPACE.ts`. Plain mode runs `tsc -p <tsconfig> --noEmit`, adding
 * `--incremental` when requested. Build mode runs `tsc -b <tsconfig>` for
 * project references, adding `--force` when `incremental` is false so the
 * check never trusts stale build info.
 */
const checkArgv = (attrs: Attrs): ReadonlyArray<string> => {
  const manager = PackageManager.registeredToolchain().packageManager
  return attrs.buildMode
    ? PackageManager.exec(manager, [
      "tsc",
      "-b",
      attrs.tsconfig.path,
      ...(attrs.incremental ? [] : ["--force"])
    ])
    : PackageManager.exec(manager, [
      "tsc",
      "-p",
      attrs.tsconfig.path,
      "--noEmit",
      ...(attrs.incremental ? ["--incremental"] : [])
    ])
}

/** The declaration form. {@link Typecheck} adds the path form to it. */
const definition = Target.make("Typecheck", {
  attrs: Attrs,
  kinds: ["build"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => Target.runTool({ cwd: attrs.cwd, env: attrs.env, argv: checkArgv(attrs) })
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
 * Expands a tsconfig path into the conventional check declaration.
 */
const fromConfigPath = (path: string): Parameters<typeof definition>[0] => {
  const site = configSite(path)
  return {
    srcs: [Input.glob("src/**/*.ts"), Input.glob("test/**/*.ts")],
    deps: [],
    tsconfig: Input.file(site.name),
    buildMode: false,
    incremental: false,
    cwd: site.cwd
  }
}

/**
 * Checks a package with `tsc --noEmit` or TypeScript build mode.
 *
 * The plan runs `tsc` in `cwd` through the shared {@link Exec.Exec} action.
 * Success carries the {@link Exec.Result} run summary; the target declares no
 * output directories. Source and tsconfig digests are declared through the
 * attrs, and dependency target keys, build-mode policy, incremental policy,
 * and the declared environment complete the key material. This models tevm's
 * `typecheck` target and TypeScript project references.
 *
 * `Typecheck("packages/plan/tsconfig.test.json")` is the path form. It runs in
 * the directory that holds the named file and expands to the same declared
 * inputs `StandardPackage` supplies to its check target: the conventional
 * source and test globs as sources, and the named file as the tsconfig.
 *
 * The tsconfig is not parsed. The source globs come from the repository
 * convention, not from the tsconfig's own `include` patterns, so a package
 * that compiles more declares it with the inline form.
 *
 * @category targets
 * @since 0.1.0
 */
export const Typecheck = Object.assign(
  (attrs: Parameters<typeof definition>[0] | string) =>
    definition(typeof attrs === "string" ? fromConfigPath(attrs) : attrs),
  definition
)
