/**
 * Conventional TypeScript package target expansion.
 *
 * @since 0.1.0
 */
import { DocsParity } from "./DocsParity.ts"
import { Dprint } from "./Dprint.ts"
import { EsLint } from "./EsLint.ts"
import * as Input from "./Input.ts"
import { NpmPublish } from "./NpmPublish.ts"
import type * as Target from "./Target.ts"
import { TsBuild } from "./TsBuild.ts"
import { Typecheck } from "./Typecheck.ts"
import { Vitest } from "./Vitest.ts"

/**
 * Options accepted by {@link StandardPackage}.
 *
 * `cwd` is the workspace-relative package directory every emitted target's
 * tool runs in. It defaults to the workspace root, so a package-level
 * BUILD.ts passes its own directory, for example `packages/plan`.
 *
 * `name`, `version`, `group`, and `private` are the package manifest fields
 * the publish target needs. `PackageDefaults.expand` reads them from the
 * matched directory and passes them in, so one declaration expands every
 * package without restating any of them. A package-level BUILD.ts passes its
 * own. Omitting `name` or `version`, declaring a group other than `engine`, or
 * declaring the package private emits no publish target, which is the same
 * release membership `scripts/pack-release.mjs` derives.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  readonly cwd?: string | undefined
  readonly name?: string | undefined
  readonly version?: string | undefined
  readonly group?: string | undefined
  /** @default false */
  readonly private?: boolean | undefined
  /** @default "https://registry.npmjs.org" */
  readonly registry?: string | undefined
  /** @default ".artifacts/release-packs" */
  readonly packDirectory?: string | undefined
  readonly sources?: Input.Glob | undefined
  /**
   * The test set. It defaults to every file under `test`, not to the spec
   * files alone: a run reads its harnesses and fixtures as well as its
   * `.test.ts` files, and a cacheable test target that declares only the spec
   * files replays a green result after a harness edit.
   */
  readonly tests?: Input.Glob | undefined
  readonly tsconfig?: Input.File | undefined
  readonly testTsconfig?: Input.File | undefined
  readonly vitestConfig?: Input.File | null | undefined
  readonly eslintConfigs?: ReadonlyArray<Input.File> | undefined
  readonly dprintConfig?: Input.File | undefined
  readonly readme?: Input.File | undefined
}

/**
 * The conventional targets emitted by {@link StandardPackage}.
 *
 * @category models
 * @since 0.1.0
 */
export interface StandardTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly check: ReturnType<typeof Typecheck>
  readonly test: ReturnType<typeof Vitest>
  readonly lint: ReturnType<typeof EsLint>
  readonly fmt: ReturnType<typeof Dprint>
  readonly docs: ReturnType<typeof DocsParity>
  readonly publish?: ReturnType<typeof NpmPublish> | undefined
}

/**
 * The release group whose packages publish to npm.
 *
 * Membership is `smthrs.group`, exactly as `scripts/pack-release.mjs` derives
 * it, so the publish set cannot drift from the release set the workflow packs.
 *
 * @category constants
 * @since 0.1.0
 */
export const releaseGroup = "engine"

/**
 * The workspace-relative directory the staged tarballs are packed into.
 *
 * `.artifacts` is git-ignored, so a staged release leaves the working tree
 * clean. Nothing in the graph writes this directory yet:
 * `scripts/pack-release.mjs <directory>` does, and the publish target declares
 * the archive it wrote as an input. A packing target is Wave 5 work.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultPackDirectory = ".artifacts/release-packs"

/**
 * The public npm registry every publish target defaults to.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultRegistry = "https://registry.npmjs.org"

/**
 * Names the archive `pnpm pack` writes for one package spec.
 *
 * pnpm drops the leading `@` of a scoped name and replaces its slash with a
 * hyphen, so `@smthrs/journal` at `0.1.0` packs to `smthrs-journal-0.1.0.tgz`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const tarballName = (name: string, version: string): string =>
  `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`

/**
 * Names the dist-tag one version publishes under.
 *
 * A prerelease version publishes to `next` and a release version to `latest`,
 * the same rule `.github/workflows/release.yml` applies to the release tag.
 *
 * @category constructors
 * @since 0.1.0
 */
export const distTag = (version: string): string => version.includes("-") ? "next" : "latest"

/**
 * Expands one conventional package into `lib`, `check`, `test`, `lint`,
 * `fmt`, `docs`, and, for a publishable package, `publish` targets.
 *
 * Defaults follow the flows repository layout: sources in `src`, tests in
 * `test`, `tsc -p` over the package `tsconfig.json`, the test half of the
 * package `check` script as `tsc -p tsconfig.test.json --noEmit`, Vitest with
 * the package `vitest.config.ts`, ESLint with the package flat
 * `eslint.config.js` plus the root `eslint.jsdoc.js`, and dprint with the
 * package `dprint.json`. Together `lib` + `check` cover what the repository's
 * package `check` scripts cover, and `lint` + `fmt` cover what its `lint`
 * scripts cover, so the `ci` verb over these targets is gate-equivalent to
 * the pnpm scripts. Lint covers the source glob only, matching the
 * repository's package lint scripts; the flat config declares no coverage
 * for test files, and ESLint 9 fails on a pattern whose matches are all
 * unconfigured. `check` depends on `lib` because the test tsconfig resolves
 * workspace dependencies through their built declarations. `docs` is the
 * documentation-parity target over the package README. It participates in
 * the `docs` verb alone; the aggregate `ci` command plans that verb alongside
 * build, test, and lint. Callers can override any shared input without
 * replacing the macro.
 *
 * `test` declares the whole test directory, not the spec files alone. Vitest
 * loads harnesses and reads fixtures of any extension, and those reads are key
 * material only if the declaration names them. `test` results replay from
 * cache, so a declaration narrowed to `.test.ts` reports the previous run's
 * green after a harness edit. `check` and `fmt` already covered the whole `.ts`
 * test tree; `test` now covers the rest of it.
 *
 * `publish` is emitted only for a package whose manifest names it, versions
 * it, puts it in the {@link releaseGroup}, and does not mark it private. It
 * publishes the staged tarball {@link defaultPackDirectory} holds, never the
 * working directory, and carries the `run` verb gate {@link NpmPublish}
 * declares, so the planner refuses it in a build, test, lint, or docs graph
 * even when one reaches it through a dependency. Nothing depends on it, so
 * `ci` neither selects nor reaches it. It depends on `lib`, because the
 * tarball contains that build's output.
 *
 * @category macros
 * @since 0.1.0
 */
export const StandardPackage = (options: Options): StandardTargets => {
  const cwd = options.cwd ?? "."
  const deps = options.deps ?? []
  const sources = options.sources ?? Input.glob("src/**/*.ts")
  const tests = options.tests ?? Input.glob("test/**/*")
  const tsconfig = options.tsconfig ?? Input.file("tsconfig.json")
  const testTsconfig = options.testTsconfig ?? Input.file("tsconfig.test.json")
  const vitestConfig = options.vitestConfig === undefined
    ? Input.file("vitest.config.ts")
    : options.vitestConfig
  const eslintConfigs = options.eslintConfigs ?? [
    Input.file("eslint.config.js"),
    Input.file("//eslint.jsdoc.js")
  ]
  const dprintConfig = options.dprintConfig ?? Input.file("dprint.json")
  const lib = TsBuild({
    srcs: [sources],
    entries: [Input.file("src/index.ts")],
    deps,
    tsconfig,
    tool: "tsc",
    format: "dual",
    outDir: "dist",
    external: [],
    cwd
  })
  const check = Typecheck({
    srcs: [sources, Input.glob("test/**/*.ts")],
    deps: [lib, ...deps],
    tsconfig: testTsconfig,
    buildMode: false,
    incremental: false,
    cwd
  })
  const test = Vitest({
    tests: [tests],
    sources: [sources],
    deps: [lib, ...deps],
    config: vitestConfig,
    environment: "node",
    passWithNoTests: false,
    cwd
  })
  const lint = EsLint({
    sources: [sources],
    deps: [],
    configs: eslintConfigs,
    maxWarnings: 0,
    fix: false,
    cwd
  })
  const fmt = Dprint({
    sources: [sources, Input.glob("test/**/*.ts")],
    deps: [],
    config: dprintConfig,
    fix: false,
    cwd
  })
  const docs = DocsParity({
    readme: options.readme ?? Input.file("README.md"),
    deps: [],
    cwd
  })
  const standard = { lib, check, test, lint, fmt, docs }
  const { group, name, version } = options
  if (name === undefined || version === undefined || group !== releaseGroup || options.private === true) {
    return standard
  }
  const packDirectory = options.packDirectory ?? defaultPackDirectory
  const publish = NpmPublish({
    packageJson: Input.file("package.json"),
    tarball: Input.file(`//${packDirectory}/${tarballName(name, version)}`),
    artifacts: [],
    deps: [lib, ...deps],
    package: name,
    version,
    registry: options.registry ?? defaultRegistry,
    access: "public",
    provenance: true,
    tag: distTag(version),
    dryRun: true
  })
  return { ...standard, publish }
}
