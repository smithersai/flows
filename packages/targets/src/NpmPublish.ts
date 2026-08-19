/**
 * npm publication targets.
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import { ExecIrreversible } from "./Changesets.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link NpmPublish}. `dryRun` defaults to true, so a real
 * publish is always an explicit opt-out in BUILD.ts.
 *
 * `tarball` is what gets published. It is the packed archive, never the
 * working package directory: this repository's manifests are source-first
 * (`exports` names `./src/index.ts`), so publishing the directory would ship
 * TypeScript source as the package entry. `scripts/pack-release.mjs` stages
 * each package into a copy whose `publishConfig.exports` has been lifted into
 * `exports` and packs that copy, and this attr names the archive it wrote.
 *
 * `package` and `version` are the published spec. They are the probe's
 * argument and stay key material, so a version bump re-keys the target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageJson: Input.File,
  tarball: Input.File,
  artifacts: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  package: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  registry: Schema.NonEmptyString,
  access: Schema.Literals(["public", "restricted"]),
  provenance: Schema.Boolean,
  tag: Schema.NonEmptyString,
  dryRun: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true)))
})

/**
 * Attributes for {@link NpmPublish}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Resolves a declared path to the argument a run at the workspace root passes.
 *
 * A workspace-rooted path drops its `//` prefix and stays relative to the
 * root. A package-relative path resolves against the declaring package, which
 * makes it absolute, and an absolute tarball path is what the release workflow
 * already passes to `pnpm publish`.
 */
const workspacePath = (path: string, context: Target.ImplementationContext): string =>
  path.startsWith("//") ? path.slice(2) : NodePath.resolve(context.packageDirectory ?? ".", path)

/**
 * The exit code an idempotence probe reports for a spec the registry does not
 * have.
 *
 * `pnpm view` exits 1 on a 404 and on a network failure alike, and neither is
 * a reason to fail the target: the release workflow treats both as "not
 * published" and lets the publish itself report the registry's verdict.
 *
 * @category constants
 * @since 0.1.0
 */
export const notPublishedExitCode = 1

/**
 * Builds the argv that asks the registry whether one spec already exists.
 *
 * npm versions are immutable, so republishing one fails. The release workflow
 * probes with `pnpm view <spec> version --json` and skips the spec it finds;
 * this is the same probe for every manager the toolchain may register.
 *
 * @category constructors
 * @since 0.1.0
 */
export const viewArgv = (
  manager: PackageManager.PackageManager,
  spec: string
): Array<string> => {
  switch (manager.name) {
    case "npm":
    case "pnpm":
      return [manager.executable, "view", spec, "version", "--json"]
    case "yarn":
      return [manager.executable, "npm", "info", spec, "version", "--json"]
    case "bun":
      return PackageManager.exec(manager, ["npm", "view", spec, "version", "--json"])
  }
}

/** The result a skipped publication reports. */
const skipped = (spec: string): Exec.Result => ({
  exitCode: 0,
  stdout: `${spec} is already published; leaving the immutable version in place.`,
  stderr: ""
})

/**
 * Plans npm publication after versioning, build, and package validation deps.
 *
 * The body plans two runs at the workspace root. The first is the idempotence
 * probe: `pnpm view <package>@<version> version --json`, through the sealed
 * exec action because it only reads, accepting
 * {@link notPublishedExitCode} beside 0 so a spec the registry does not have
 * is an answer rather than a failure. The plan then branches on its exit code.
 * A published spec short-circuits to a skip result, because npm versions are
 * immutable and a rerun of the target would otherwise hard-fail. An
 * unpublished spec runs `pnpm publish <tarball>` through
 * {@link ExecIrreversible}: publication changes external registry state, so it
 * is irreversible tier and never cacheable.
 *
 * The published artifact is the declared tarball, never the working package
 * directory. Registry, access, and dist-tag come from attrs and land on argv;
 * they mirror the generated manifest's publishConfig, which pnpm reads from
 * the packed manifest itself. Provenance is `--provenance` on argv, matching
 * `.github/workflows/release.yml`, and is omitted on a dry run because
 * provenance needs the CI identity token that a dry run does not mint. Git
 * checks are disabled: tree policy belongs to the release pipeline, not the
 * publish step. `dryRun` defaults to true and appends `--dry-run`. Key
 * material records the manifest and tarball digests, artifact digests,
 * dependency keys, published spec, registry, access, provenance, tag, and
 * dry-run policy. Publication follows `npm publish` and the release workflow
 * and runs before JSR publication. Its `run` verb gate rejects inclusion in
 * build, test, lint, and docs graphs, including through dependencies.
 * Executing the plan requires {@link Exec.ExecLive} for the probe and
 * {@link ExecIrreversibleLive} from the Changesets module for the publish.
 *
 * @category targets
 * @since 0.1.0
 */
export const NpmPublish = Target.make("NpmPublish", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  verbGate: ["run"],
  implementation: (attrs, context) => {
    const manager = PackageManager.registeredToolchain().packageManager
    const spec = `${attrs.package}@${attrs.version}`
    const argv: Array<string> = PackageManager.publish(manager, [
      workspacePath(attrs.tarball.path, context),
      "--registry",
      attrs.registry,
      "--access",
      attrs.access,
      "--tag",
      attrs.tag,
      "--no-git-checks"
    ])
    if (attrs.provenance && !attrs.dryRun) argv.push("--provenance")
    if (attrs.dryRun) argv.push("--dry-run")
    return Target.runTool({
      cwd: ".",
      argv: viewArgv(manager, spec),
      expectedExitCodes: [0, notPublishedExitCode]
    }).pipe(
      Node.branch({
        if: (probe: Exec.Result) => probe.exitCode === 0,
        then: () => Node.succeed(skipped(spec)),
        else: () => ExecIrreversible.call({ cwd: ".", argv })
      })
    )
  }
})
