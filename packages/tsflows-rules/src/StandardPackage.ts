/**
 * Conventional TypeScript package target expansion.
 *
 * @since 0.1.0
 */
import { DocsParity } from "./DocsParity.ts"
import { Dprint } from "./Dprint.ts"
import { EsLint } from "./EsLint.ts"
import * as Input from "./Input.ts"
import type * as Rule from "./Rule.ts"
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
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** @default [] */
  readonly deps?: ReadonlyArray<Rule.AnyTarget> | undefined
  readonly cwd?: string | undefined
  readonly sources?: Input.Glob | undefined
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
}

/**
 * Expands one conventional package into `lib`, `check`, `test`, `lint`,
 * `fmt`, and `docs` targets.
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
 * documentation-parity target over the package README; it participates in
 * the `docs` verb alone, so it never joins the `build`, `test`, and `lint`
 * graph the `ci` command runs. Callers can override any shared input without
 * replacing the macro.
 *
 * @category macros
 * @since 0.1.0
 */
export const StandardPackage = (options: Options): StandardTargets => {
  const cwd = options.cwd ?? "."
  const deps = options.deps ?? []
  const sources = options.sources ?? Input.glob("src/**/*.ts")
  const tests = options.tests ?? Input.glob("test/**/*.test.ts")
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
  return { lib, check, test, lint, fmt, docs }
}
