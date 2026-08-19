/**
 * Root smithers build targets for the flows workspace.
 *
 * Every TypeScript-specific root file is declared here and generated from this
 * file: the workspace definition, the workspace tsconfig, and the lockfile.
 * `nodeModules` is a target produced by the `Install` target, keyed on the
 * registered toolchain and the generated lockfile.
 *
 * The toolchain lives in `WORKSPACE.ts`, which registers it once. No target
 * here takes a runtime or a package manager as an attr; every rule reads the
 * registration. Nothing in the target catalog spells `pnpm` or `node` into an
 * argv, so switching either is an edit to `WORKSPACE.ts`.
 *
 * `workspace`, `lockfile`, and `nodeModules` stay in this file rather than
 * moving to `WORKSPACE.ts`. They are targets, and only a `BUILD.ts` file
 * contributes targets to a package, so moving them would delete the labels
 * `//:workspace`, `//:lockfile`, and `//:nodeModules`, and with them the bare
 * `//` default target that resolves to `nodeModules`.
 */
import { Smithers } from "@smthrs/targets"

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * The remote-cache bearer token, declared beside the one target that reads it.
 * A `BUILD.ts` file cannot import `WORKSPACE.ts`: the two are loaded under
 * different module URLs, so the import evaluates `WORKSPACE.ts` a second time
 * and its `registerToolchains` call refuses the duplicate registration.
 *
 * `Secret` names the environment variable the value is read from at execution
 * time. A target that declares this secret is
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
export const lockfile = Smithers.Lockfile({ workspace })

// ---------------------------------------------------------------------------
// node_modules
// ---------------------------------------------------------------------------

export const nodeModules = Smithers.Install({ lockfile, workspace })

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
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  kinds: ["build", "test", "lint", "docs"],
  gates: [{ name: "documentation parity", command: "pnpm exec smthrs docs '//...'", job: "test" }]
})

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage
})
