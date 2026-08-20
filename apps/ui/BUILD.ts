/**
 * Targets for the UI application: the typecheck, the unit suite, and the two
 * end-to-end suites.
 *
 * The e2e suites boot `wrangler dev` and a real Chrome, so they are separate
 * targets rather than folded into the unit suite: a pipeline that ran them on
 * every push would put minutes of browser work in front of every change for no
 * added signal. The CI jobs address the two lanes by exact label for that
 * reason — a bare `//apps/ui` under the test verb would pull both into one job.
 *
 * Everything runs under Bun, which is what the app's own scripts use, so the
 * runtime is the root Bun declaration and nothing here spells `bun` into an
 * argv.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../BUILD.ts"

const cwd = "apps/ui"

/** The application sources every suite drives. */
const sources = Smithers.glob("//apps/ui/src/**/*.ts")

/** The React components, part of the typecheck's and unit suite's key material. */
const componentSources = Smithers.glob("//apps/ui/src/**/*.tsx")

/** The stylesheets the SPA bundles; a CSS-only change must invalidate the e2e and unit caches too. */
const styleSources = Smithers.glob("//apps/ui/src/**/*.css")

/** The build/runtime configs a bundler boot reads; editing one changes what the e2e suites serve. */
const buildConfigs = [
  Smithers.file("vite.config.ts"),
  Smithers.file("vite.start.config.ts"),
  Smithers.file("tailwind.config.js"),
  Smithers.file("postcss.config.js"),
]

/** The worker the e2e suites boot under `wrangler dev`. */
const serverSources = Smithers.glob("//apps/server/src/**/*.ts")

/**
 * The harness and suite sources outside `src/`. The tsconfig compiles them, so
 * the typecheck measures them and its key has to carry them too.
 */
const harnessSources = Smithers.glob("//apps/ui/scripts/**/*.ts")
const suiteSources = Smithers.glob("//apps/ui/e2e/**/*.ts")

/**
 * Checks the application against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
export const check = Smithers.Typecheck({
  packageManager,
  /*
   * Everything this tsconfig includes. `scripts`, `e2e`, and the bundler
   * configs are compiled by this target — `vite.start.config.ts` only joined
   * the include recently — so a key made of `src` alone would serve a green
   * cache entry over an edit that breaks the typecheck.
   */
  srcs: [
    sources,
    componentSources,
    harnessSources,
    suiteSources,
    ...buildConfigs,
    Smithers.file("electrobun.config.ts")
  ],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `src/`, hermetic, no server and no browser.
 *
 * @since 0.1.0
 * @category test
 */
export const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["src"]),
  srcs: [sources, componentSources, styleSources],
  deps: [],
  cwd
})

/**
 * Boots `wrangler dev` against the stub backends twice and asserts the named
 * outcomes.
 *
 * Hermetic: workerd runs locally, so no Cloudflare credential is involved and no
 * model spend happens.
 *
 * @since 0.1.0
 * @category test
 */
export const workerE2e = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.entrypoint(Smithers.file("scripts/worker-e2e.ts")),
  srcs: [sources, componentSources, styleSources, ...buildConfigs, serverSources, harnessSources],
  deps: [],
  cwd
})

/**
 * Drives the built SPA in a real browser through the checked-in scenario set.
 *
 * The runner discovers a browser from the candidate paths in
 * `src/launch-checklist/BrowserLaunch.ts`; the CI job declares the same
 * executable as a requirement, so a runner image without it fails with a
 * readable message rather than inside a CDP connect timeout.
 *
 * @since 0.1.0
 * @category test
 */
export const browserE2e = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.entrypoint(Smithers.file("e2e/run.ts")),
  srcs: [sources, componentSources, styleSources, ...buildConfigs, serverSources, suiteSources],
  deps: [],
  cwd
})
