/**
 * Root smithers build targets for the flows workspace.
 *
 * Every generated root file is declared here and generated from this file: the
 * workspace definition, the workspace tsconfig, the lockfile, and the GitHub
 * Actions pipeline. `nodeModules` is a target produced by the `Install` target,
 * keyed on the declared toolchain and the generated lockfile.
 *
 * The runtime and the package manager are declared once and passed to every
 * target that runs a tool. Nothing in the target catalog spells `pnpm` or `node`
 * into an argv any more, so switching either is an edit to this file.
 *
 * Nothing in this file is a command. Targets are declared here; the argv each
 * one runs is rendered inside its implementation, from these declarations. A
 * `run:` string, a raw executable name, or a shell fragment in a BUILD.ts file
 * is a gate outside the build graph — unplanned, unkeyed, unaddressable — and
 * the schemas in `@smthrs/targets` no longer have a field that would hold one.
 */
import { Smithers } from "@smthrs/targets"

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Every root file a target consumes is declared here, once. Targets reference
 * these declarations; nothing declares a file inline.
 */
export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const pnpmWorkspace = Smithers.file("//pnpm-workspace.yaml")

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

/**
 * The second interpreter the workspace supports.
 *
 * It is a declaration, not a preference: the Bun compatibility matrix in
 * `ci/BUILD.ts` and the UI end-to-end targets in `apps/ui/BUILD.ts` run under
 * it, and both take it from here rather than spelling `bun` into an argv.
 */
export const bunRuntime = Smithers.Runtime.Bun({ version: ">=1.3.0" })

/**
 * Bun as a package manager, for the targets that run tools under it.
 *
 * Bun is its own runtime, so the declaration carries no separate version.
 */
export const bunPackageManager = Smithers.PackageManager.BunPackages({ runtime: bunRuntime })

/**
 * The Rust toolchain the crates build with.
 *
 * `rust-toolchain.toml` pins the compiler, the `wasm32-wasip1` target, and the
 * rustfmt and clippy components. The declaration names that pin, so the cargo
 * targets and the pipeline's toolchain install are keyed on the same file and
 * cannot drift from each other.
 */
export const rustToolchain = Smithers.RustToolchain.Pinned({})

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

/**
 * Generates and drift-checks `pnpm-workspace.yaml`.
 *
 * Editing this is a FOUR-file change, because two conformance suites pin the
 * result and neither can import this file (both live in packages this file
 * imports):
 *
 *  1. here,
 *  2. the generated `pnpm-workspace.yaml` (`smthrs build //:workspace`),
 *  3. `packages/targets/test/GeneratedRootFiles.test.ts`, which re-declares
 *     these attributes and re-renders them,
 *  4. `packages/flows/test/vitestCoverageIsolation.test.ts`, which pins the
 *     generated file's exact text.
 *
 * The duplication is deliberate: 3 and 4 exist so that widening the workspace,
 * or letting a package run an install script, has to be justified in review
 * rather than slipping in. Miss one and CI reports the generated file as a
 * hand edit — accurately, from where it is standing.
 */
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
  extends: rootTsconfig,
  compilerOptions: {
    noEmit: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    paths: { "*": ["./*"] }
  },
  include: [
    "BUILD.ts",
    "apps/*/BUILD.ts",
    "ci/BUILD.ts",
    "crates/*/BUILD.ts",
    "evals/*/BUILD.ts",
    "lint/BUILD.ts",
    "scripts/BUILD.ts",
    "packages/*/BUILD.ts",
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
// GitHub Actions
// ---------------------------------------------------------------------------

/** The runner every job in the pipeline uses unless it names another. */
const ubuntu = "ubuntu-latest"

/** Node as the pipeline installs it, with the pnpm store cached. */
const node = Smithers.CiToolchain.Node({ runtime, release: "22.19.0" })

/** Node without the pnpm store cache, for a job whose install is not the hot path. */
const bareNode = Smithers.CiToolchain.Node({ runtime, release: "22.19.0", cachePackageStore: false })

/** Bun as the pipeline installs it. */
const bun = Smithers.CiToolchain.Bun({ runtime: bunRuntime, release: "1.3.14" })

/**
 * The jj binary the real-binary suites require.
 *
 * Issue #163: without jj on PATH those suites fail loudly rather than skipping
 * silently. A GitHub checkout is a git repository and not a jj one, so the
 * colocated metadata is initialized before the contracts run.
 */
const jj = Smithers.CiToolchain.Jj({ release: "0.39.0" })

/**
 * The GitHub Actions pipeline, generated from this declaration.
 *
 * `.github/workflows/ci.yml` is a generated root file like `pnpm-workspace.yaml`
 * and `tsconfig.json`, written by `smthrs build //:ci` and drift-checked by every
 * other verb. Editing the YAML directly fails the check; edit this declaration
 * instead.
 *
 * NOTHING BELOW IS A COMMAND. A job declares what a runner must provide before
 * it can work (`toolchain`) and which targets it runs (`steps`). Every argv the
 * generated file carries — the checkout, the installs, the toolchain setup, and
 * each `pnpm exec smthrs <verb> <pattern>` — is rendered by `GithubCiGen` from
 * those declarations and from the runtime and package-manager declarations at
 * the top of this file. A gate that is not a target cannot be added to the
 * pipeline; it has to become a target first, in the package that owns it. That
 * is the same rule Bazel enforces by having no way to write a command in a
 * `BUILD` file at all.
 */
export const ci = Smithers.GithubCiGen({
  packageManager,
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  workflowDispatch: false,
  mode: "check",
  gates: [
    // Claims that outlive the job list. Checked structurally against the steps
    // below, so dropping the invocation is a throw at plan time.
    { name: "documentation parity", verb: Smithers.Verb.Docs, pattern: "//packages/...", job: "test" },
    { name: "browser contract", verb: Smithers.Verb.Test, pattern: "//scripts:browserContract" }
  ],
  requiredJobs: ["test", "apps-e2e", "rust", "wasm-repro", "bun", "browser", "node-macos", "node-windows"],
  jobs: [
    {
      id: "test",
      name: "workspace graph (coverage gates enforced)",
      runsOn: ubuntu,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        jj,
        // actionlint catches GitHub-only expression-context errors before any
        // workflow runs. Every file in .github/workflows/ is named here, and
        // apps/server/scripts/canary/workflow-wiring.test.ts fails when one is
        // missing: an unlinted workflow is a workflow whose expression errors
        // surface at 03:00 on a schedule instead of in review.
        workflowLint: Smithers.CiToolchain.Actionlint({
          release: "1.7.11",
          workflows: [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/apps-deploy.yml",
            ".github/workflows/canary.yml"
          ]
        })
      }),
      steps: [
        // The aggregate verb over the package graph: build, test, lint, and
        // docs in one invocation rather than four that re-plan the same graph.
        // StandardPackage expands each package into lib, check, test, lint,
        // fmt, docs, and circular, so this is what the recursive pnpm scripts
        // used to cover. Two concurrent targets: the heavy vitest suites carry
        // finite 30s per-test budgets that host parallelism on a 4-core runner
        // starves when several run at once.
        { name: "Workspace targets", verb: Smithers.Verb.Ci, pattern: "//packages/...", parallelism: 2 },
        // The operator and release script gates, including the browser contract
        // and the release pack-and-smoke chain.
        { name: "Script gates", verb: Smithers.Verb.Test, pattern: "//scripts/..." },
        // The offline agent evaluation suite and its own typecheck. Both gate
        // on the committed baseline, and neither reaches the network.
        {
          name: "Agent eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/agent:suite"
        },
        { name: "Agent eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/agent:types" },
        // The workflow this declaration generates, drift-checked against the
        // checked-in file. Without this step the generated-file contract would
        // hold everywhere except for the file describing the pipeline itself.
        { name: "Generated workflow drift", verb: Smithers.Verb.Lint, pattern: "//:ci" }
      ]
    },
    // Issue I-1: the apps' end-to-end suites, a separate job because they boot
    // wrangler dev and a real Chrome. No jj: nothing under apps/ spawns it.
    {
      id: "apps-e2e",
      name: "apps e2e (worker + browser)",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        // The ubuntu-latest image ships Google Chrome stable at this path, which
        // BROWSER_CANDIDATES in apps/ui/src/launch-checklist/BrowserLaunch.ts
        // already probes. Assert it rather than assume it.
        browser: Smithers.CiToolchain.Browser({
          executable: "/usr/bin/google-chrome",
          reason: "findBrowser only probes BROWSER_CANDIDATES in apps/ui/src/launch-checklist/BrowserLaunch.ts"
        }),
        // Screenshots land in /tmp and launch-checklist reports under
        // apps/reports; both are collected into one directory so the upload has
        // a single root.
        artifacts: Smithers.CiToolchain.Artifacts({
          artifact: "apps-e2e-artifacts",
          sources: [{ from: "/tmp/smithers-*.png" }, { from: "apps/reports", as: "reports" }]
        })
      }),
      steps: [{ name: "UI end-to-end suites", verb: Smithers.Verb.Test, pattern: "//apps/ui" }]
    },
    // rust-toolchain.toml pins the toolchain for the two Rust jobs; the declared
    // toolchain names that pin, and a bare `rustup toolchain install` reads it,
    // so the pin cannot drift from what CI runs.
    {
      id: "rust",
      name: "rust fmt + clippy + test",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        submodules: true,
        runtimes: [bareNode],
        rust: Smithers.CiToolchain.Rust({ toolchain: rustToolchain })
      }),
      steps: [
        { name: "Cargo lint gates", verb: Smithers.Verb.Lint, pattern: "//crates/flows-jj" },
        { name: "Cargo test suite", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:cargoTest" }
      ]
    },
    // The committed packages/jj/wasm/flows_jj.wasm is a reproducibility
    // contract: rebuilding it from source with the pinned toolchain must give
    // the same bytes. No build cache here on purpose — the rebuild is the point.
    // The runner's host triple is part of the contract, and build-wasm.mjs
    // refuses to run on any other host, so a runner change fails with that
    // message rather than a byte diff.
    {
      id: "wasm-repro",
      name: "wasm reproducibility",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        submodules: true,
        runtimes: [bareNode],
        rust: Smithers.CiToolchain.Rust({ toolchain: rustToolchain, cache: false })
      }),
      steps: [
        { name: "Build-script unit tests", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:buildScript" },
        {
          name: "Rebuild and byte-compare flows_jj.wasm",
          verb: Smithers.Verb.Test,
          pattern: "//crates/flows-jj:wasmReproducibility"
        }
      ]
    },
    // Runtime compatibility: the suites in //ci pass under bun today. Which
    // packages are in that matrix, and why every other one is excluded, is
    // recorded in ci/BUILD.ts.
    {
      id: "bun",
      name: "test on bun",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj }),
      steps: [{ name: "Bun-compatible suites", verb: Smithers.Verb.Test, pattern: "//ci/..." }]
    },
    // The browser contract as its own gate. No real browser-runner suite exists
    // in this repository yet; when one lands, run it here instead of inventing a
    // new harness.
    {
      id: "browser",
      name: "browser bundle gate",
      runsOn: ubuntu,
      timeoutMinutes: 10,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node] }),
      steps: [{ name: "Browser bundle guard", verb: Smithers.Verb.Test, pattern: "//scripts:browserContract" }]
    },
    // Advisory OS coverage for the package test suites. Both jobs become
    // required (drop continueOnError) once they prove a stable green streak.
    // Windows path pitfalls are expected and are not chased in this lane.
    {
      id: "node-macos",
      name: "package suites (macOS, advisory)",
      runsOn: "macos-latest",
      continueOnError: true,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj }),
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/..." }]
    },
    {
      id: "node-windows",
      name: "package suites (Windows, advisory)",
      runsOn: "windows-latest",
      continueOnError: true,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj }),
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/..." }]
    }
  ]
})

/**
 * Default targets for packages that have no BUILD.ts file of their own.
 *
 * The planner matches every `packages/*` directory that contains a
 * `package.json` and lacks a `BUILD.ts`, then applies the `StandardPackage`
 * macro to each match with these attrs, synthesizing the conventional `lib`,
 * `check`, `test`, `lint`, `fmt`, and `docs` targets. A package writes its own
 * BUILD.ts only when it deviates from the standard layout.
 */
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage,
  attrs: { packageManager }
})
