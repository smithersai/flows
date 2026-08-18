/**
 * Root smithers build targets for the flows workspace.
 *
 * Every TypeScript-specific root file is declared here and generated from this
 * file: the workspace definition, the workspace tsconfig, and the lockfile.
 * `nodeModules` is a target produced by the `Install` target, keyed on the
 * declared toolchain and the generated lockfile.
 *
 * The runtime and the package manager are declared once and passed to every
 * target that runs a tool. Nothing in the target catalog spells `pnpm` or `node`
 * into an argv any more, so switching either is an edit to this file.
 */
import { Smithers } from "@smthrs/targets"

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------

/**
 * The interpreter every tool runs under. The declaration is a requirement: the
 * Runtime service measures the host and refuses to execute when it does not
 * satisfy this.
 */
export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })

/**
 * The package manager. It takes the runtime as a dependency because pnpm is
 * itself a program the runtime executes.
 */
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * The remote-cache bearer token. `Secret` names the environment variable the
 * value is read from at execution time. A target that declares this secret is
 * given an unguessable placeholder in its environment; the substituting proxy
 * swaps the placeholder for the real value on outbound requests. Key material
 * records the variable name, never the value.
 */
export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")

/** The remote-cache endpoint override, resolved the same way. */
export const cacheUrl = Smithers.Secret("SMITHERS_CACHE_URL")

// ---------------------------------------------------------------------------
// Generated root files
// ---------------------------------------------------------------------------

/** Generates and drift-checks `pnpm-workspace.yaml`. */
export const workspace = Smithers.PnpmWorkspace({
  packageManager,
  packages: ["packages/*", "packages/build/infra", "examples", "apps/*"],
  allowBuilds: {
    "@journeyapps/wa-sqlite": false,
    dprint: false,
    "es5-ext": false,
    esbuild: false,
    "msgpackr-extract": false,
    // apps/ui's live-* checks drive Playwright. Its postinstall downloads
    // browsers; those checks run against a system or already-installed
    // browser, so an install never pulls one down.
    playwright: false,
    sharp: false,
    "unrs-resolver": false,
    "vue-demi": false,
    workerd: false
  },
  linkWorkspacePackages: true,
  settings: {
    // pnpm 11 reads settings from pnpm-workspace.yaml alone, so the gate run
    // must never reinstall what it is measuring: installation is an explicit
    // step (the workflow's install step locally, the Install target under the
    // build system), and a `--ignore-scripts` install hashes differently than
    // a default one, making a spurious "mismatch" routine.
    verifyDepsBeforeRun: false
  }
})

/** Generates and drift-checks the workspace `tsconfig.json`. */
export const tsconfig = Smithers.Tsconfig({
  extends: Smithers.file("tsconfig.base.json"),
  compilerOptions: {
    noEmit: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    paths: { "*": ["./*"] }
  },
  include: [
    "packages/*/src/**/*",
    "packages/*/test/**/*",
    "packages/storage/*/src/**/*",
    "packages/storage/*/test/**/*",
    "packages/coding-agent/examples/**/*"
  ],
  exclude: ["**/dist/**", "packages/coding-agent/examples/extensions/gondolin/**"]
})

/**
 * Generates `pnpm-lock.yaml` from the workspace definition and every package
 * manifest. The lockfile is this target's output and the install target's
 * input, which is why the two are separate: a target cannot be keyed on a file it
 * produces.
 */
export const lockfile = Smithers.Lockfile({
  packageManager,
  workspace
})

// ---------------------------------------------------------------------------
// node_modules
// ---------------------------------------------------------------------------

export const nodeModules = Smithers.Install({
  packageManager,
  lockfile,
  workspace
})

// ---------------------------------------------------------------------------
// Shared declarations and workspace policy
// ---------------------------------------------------------------------------

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const pnpmWorkspace = Smithers.file("//pnpm-workspace.yaml")

// .github/workflows/ci.yml is hand-written. This target's default `contract`
// mode only verifies the checked-in workflow still runs the declared gates;
// only an explicit `write` mode would regenerate the file.
export const ci = Smithers.GithubCiGen({
  packageManager,
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  kinds: ["build", "test", "lint", "docs"],
  gates: [{ name: "documentation parity", command: "pnpm exec smthrs docs '//...'", job: "test" }]
})

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage,
  attrs: { packageManager }
})
