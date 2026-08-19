/**
 * End-to-end targets for the UI application.
 *
 * These suites boot `wrangler dev` and a real Chrome, so they are declared here
 * rather than folded into the package's unit test target: a pipeline that ran
 * them on every push would put minutes of browser work in front of every change
 * for no added signal. The CI job that runs them addresses them by exact label
 * for that reason.
 *
 * Both run under Bun, which is what the app's own scripts use, so the runtime is
 * the root Bun declaration and nothing here spells `bun` into an argv.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime } from "../../BUILD.ts"

const cwd = "apps/ui"

/** The application sources both suites drive. */
const sources = Smithers.glob("//apps/ui/src/**/*.ts")

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
  srcs: [sources, Smithers.glob("//apps/ui/scripts/**/*.ts")],
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
  srcs: [sources, Smithers.glob("//apps/ui/e2e/**/*.ts")],
  deps: [],
  cwd
})
