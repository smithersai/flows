/**
 * dprint formatting checks.
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
 * Attributes for {@link Dprint}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. `config` is the dprint configuration file; the tool
 * discovers the files it checks from that configuration, so `sources` exists
 * purely as declared key material for the files a formatting verdict depends
 * on.
 *
 * `env` declares the environment variables the tool run needs. It is key
 * material, so a target that reads a variable such as `FC_SEED` declares it
 * here and re-keys when the value changes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Input.File,
  fix: Schema.Boolean,
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Dprint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** The declaration form. {@link Dprint} adds the path form to it. */
const definition = Target.make("Dprint", {
  attrs: Attrs,
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) => {
    const manager = PackageManager.registeredToolchain().packageManager
    return Target.runTool({
      cwd: attrs.cwd,
      env: attrs.env,
      argv: PackageManager.exec(manager, [
        "dprint",
        attrs.fix ? "fmt" : "check",
        "--config",
        attrs.config.path
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
 * Expands a config-file path into the conventional dprint declaration.
 */
const fromConfigPath = (path: string): Parameters<typeof definition>[0] => {
  const site = configSite(path)
  return {
    sources: [Input.glob("src/**/*.ts"), Input.glob("test/**/*.ts")],
    deps: [],
    config: Input.file(site.name),
    fix: false,
    cwd: site.cwd
  }
}

/**
 * Checks formatting with `dprint check`, or rewrites it with `dprint fmt`.
 *
 * The plan records one {@link Exec.Exec} run of `dprint` from `cwd` with the
 * declared configuration passed as `--config`, mirroring the repository's
 * package lint scripts (`... && dprint check`). Key material contains the
 * source and configuration digests, dependency keys, the fix mode, and the
 * declared environment. The
 * target remains non-cacheable until the external dprint toolchain is
 * complete key material, matching {@link EsLint}'s posture. Executing the
 * plan requires {@link Exec.ExecLive}.
 *
 * `Dprint("packages/plan/dprint.json")` is the path form. It runs in the
 * directory that holds the named file and expands to the same declared inputs
 * `StandardPackage` supplies: the conventional source and test globs as
 * sources, and the named file as the config.
 *
 * The config file is not parsed. The source globs come from the repository
 * convention, not from dprint's own `includes` patterns.
 *
 * @category targets
 * @since 0.1.0
 */
export const Dprint = Object.assign(
  (attrs: Parameters<typeof definition>[0] | string) =>
    definition(typeof attrs === "string" ? fromConfigPath(attrs) : attrs),
  definition
)
