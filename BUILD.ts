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
// Repository gates
// ---------------------------------------------------------------------------

/**
 * Every package manifest in the workspace, named one by one.
 *
 * A glob cannot express this. `Smithers.glob("packages/*\/package.json")` is
 * declared in the root package, and every `packages/*` directory carries its
 * own `BUILD.ts`, so the planner stops the expansion at each boundary and
 * refuses the target. A rooted `Smithers.file` declaration crosses a package
 * boundary the way a glob cannot, so the gates below name the files.
 *
 * The list is maintenance the planner enforces: a new package whose manifest
 * is missing here leaves a gate that reads it cacheable on incomplete key
 * material, which is exactly the manifest drift `//:packReleaseTest` and
 * `//:setReleaseVersionTest` exist to catch.
 */
const packageManifests = [
  Smithers.file("//packages/artifacts/package.json"),
  Smithers.file("//packages/build/package.json"),
  Smithers.file("//packages/build-cli/package.json"),
  Smithers.file("//packages/canonical/package.json"),
  Smithers.file("//packages/capability/package.json"),
  Smithers.file("//packages/chain/package.json"),
  Smithers.file("//packages/cli/package.json"),
  Smithers.file("//packages/control/package.json"),
  Smithers.file("//packages/core/package.json"),
  Smithers.file("//packages/crypto/package.json"),
  Smithers.file("//packages/database/package.json"),
  Smithers.file("//packages/engine/package.json"),
  Smithers.file("//packages/engine-harness/package.json"),
  Smithers.file("//packages/engine-store/package.json"),
  Smithers.file("//packages/evals/package.json"),
  Smithers.file("//packages/flow/package.json"),
  Smithers.file("//packages/flows/package.json"),
  Smithers.file("//packages/fs/package.json"),
  Smithers.file("//packages/gateway/package.json"),
  Smithers.file("//packages/harness/package.json"),
  Smithers.file("//packages/jj/package.json"),
  Smithers.file("//packages/journal/package.json"),
  Smithers.file("//packages/kernel/package.json"),
  Smithers.file("//packages/keys/package.json"),
  Smithers.file("//packages/memory/package.json"),
  Smithers.file("//packages/model/package.json"),
  Smithers.file("//packages/notifications/package.json"),
  Smithers.file("//packages/observability/package.json"),
  Smithers.file("//packages/patterns/package.json"),
  Smithers.file("//packages/plan/package.json"),
  Smithers.file("//packages/platform-browser/package.json"),
  Smithers.file("//packages/platform-bun/package.json"),
  Smithers.file("//packages/platform-node/package.json"),
  Smithers.file("//packages/plugin/package.json"),
  Smithers.file("//packages/registry/package.json"),
  Smithers.file("//packages/run-store/package.json"),
  Smithers.file("//packages/sandbox/package.json"),
  Smithers.file("//packages/scorers/package.json"),
  Smithers.file("//packages/std/package.json"),
  Smithers.file("//packages/step-cache/package.json"),
  Smithers.file("//packages/sync/package.json"),
  Smithers.file("//packages/targets/package.json"),
  Smithers.file("//packages/testing/package.json"),
  Smithers.file("//packages/time-travel/package.json"),
  Smithers.file("//packages/triggers/package.json")
]

/**
 * The circular-dependency guard. `ci.yml`'s `Circular-dependency guard` step.
 *
 * The target is deliberately coarse and says so. `pnpm run circular` is
 * `pnpm --recursive --if-present run circular`, and there is no root
 * `scripts/circular.mjs`: the work is 45 per-package copies of that script,
 * each running madge over one package's `src`. This one root target wraps the
 * recursive command, so the graph gains a label for the gate without claiming
 * per-package granularity it does not have. Splitting it into 45 targets is a
 * later change, and it belongs in the package macro rather than here.
 *
 * `cache: false` follows from the same fact. The real read set is every
 * package's sources, which a root glob cannot reach across the package
 * boundaries, so the key material would be incomplete and a hit would replay a
 * guard that never ran.
 *
 * @since 0.1.0
 * @category build
 */
export const circular = Smithers.ToolBuild({
  tool: "pnpm",
  command: "pnpm",
  args: ["run", "circular"],
  inputs: [],
  outputs: [],
  deps: [],
  env: {},
  cache: false,
  cwd: "."
})

/**
 * The browser bundle guard. `ci.yml`'s `Browser bundle guard` step, which the
 * file runs twice: once in the `test` job and once as the whole `browser` job.
 *
 * `scripts/browser-check.mjs` bundles 24 browser entry points and pins 7
 * documented Node-only ones, so its read set is the transitive source closure
 * of most of the workspace. That closure is not declarable from the root
 * package, so the target declares the script it runs and takes `cache: false`
 * rather than claiming a key it does not have.
 *
 * @since 0.1.0
 * @category build
 */
export const browser = Smithers.ToolBuild({
  tool: "pnpm",
  command: "pnpm",
  args: ["run", "browser"],
  inputs: [Smithers.file("scripts/browser-check.mjs")],
  outputs: [],
  deps: [],
  env: {},
  cache: false,
  cwd: "."
})

/**
 * The release manifest unit test. `ci.yml`'s `Release manifest unit test`
 * step.
 *
 * The declared inputs are the complete read set, which is what makes the
 * target cacheable. The suite reads BOTH workflow files — it asserts that
 * every gate in `ci.yml` also runs in `release.yml` — and every package
 * manifest, twice over: once through `readWorkspaceManifests` and once through
 * its own independent walk of `packages/`. A cacheable target missing those
 * declarations would replay green over exactly the manifest drift it exists to
 * catch.
 *
 * @since 0.1.0
 * @category build
 */
export const packReleaseTest = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["--test", "scripts/pack-release.test.mjs"],
  inputs: [
    Smithers.file("scripts/pack-release.test.mjs"),
    Smithers.file("scripts/pack-release.mjs"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//.github/workflows/release.yml"),
    ...packageManifests
  ],
  outputs: [],
  deps: [],
  env: {},
  cache: true,
  cwd: "."
})

/**
 * The release rehearsal unit test. `ci.yml`'s `Release rehearsal unit test`
 * step. Its assertions read `release.yml` itself, so that file is declared
 * key material.
 *
 * @since 0.1.0
 * @category build
 */
export const releaseRehearsalTest = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["--test", "scripts/release-rehearsal.test.mjs"],
  inputs: [
    Smithers.file("scripts/release-rehearsal.test.mjs"),
    Smithers.file("scripts/release-rehearsal.mjs"),
    Smithers.file("//.github/workflows/release.yml")
  ],
  outputs: [],
  deps: [],
  env: {},
  cache: true,
  cwd: "."
})

/**
 * The release version coherence gate. `ci.yml`'s `Release version coherence`
 * step.
 *
 * Its last case calls `readManifests()`, which reads every manifest live, so
 * the manifests are declared. Without them the gate would replay a stale pass
 * over a tree whose internal ranges no longer agree.
 *
 * @since 0.1.0
 * @category build
 */
export const setReleaseVersionTest = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["--test", "scripts/set-release-version.test.mjs"],
  inputs: [
    Smithers.file("scripts/set-release-version.test.mjs"),
    Smithers.file("scripts/set-release-version.mjs"),
    ...packageManifests
  ],
  outputs: [],
  deps: [],
  env: {},
  cache: true,
  cwd: "."
})

/**
 * The disaster-recovery script test. `ci.yml`'s `Disaster-recovery script
 * test` step. It spawns `scripts/flows-backup.mjs` against stores it builds in
 * a temporary directory, so the two scripts are the whole read set.
 *
 * @since 0.1.0
 * @category build
 */
export const flowsBackupTest = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["--test", "scripts/flows-backup.test.mjs"],
  inputs: [
    Smithers.file("scripts/flows-backup.test.mjs"),
    Smithers.file("scripts/flows-backup.mjs")
  ],
  outputs: [],
  deps: [],
  env: {},
  cache: true,
  cwd: "."
})

/**
 * The test-pin register guard. `ci.yml`'s `Test-pin register guard` step.
 *
 * `cache: false`, for the same reason as `//:circular`. The guard walks every
 * test file of every package in the `engine` and `tooling` groups looking for
 * `it.fails` pins, and that tree is behind package boundaries a root glob does
 * not cross. The manifests and the register it reads are declared so the key
 * names what it can, and the walk keeps the target out of the cache.
 *
 * @since 0.1.0
 * @category build
 */
export const checkTestPinsTest = Smithers.ToolBuild({
  tool: "node",
  command: "node",
  args: ["--test", "scripts/check-test-pins.test.mjs"],
  inputs: [
    Smithers.file("scripts/check-test-pins.test.mjs"),
    Smithers.file("scripts/check-test-pins.mjs"),
    Smithers.file("//docs/alpha-notes.md"),
    ...packageManifests
  ],
  outputs: [],
  deps: [],
  env: {},
  cache: false,
  cwd: "."
})

// ---------------------------------------------------------------------------
// Shared declarations and workspace policy
// ---------------------------------------------------------------------------

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const pnpmWorkspace = Smithers.file("//pnpm-workspace.yaml")

/**
 * The contract `.github/workflows/ci.yml` is held to.
 *
 * The file is hand-written and stays hand-written. `contract` mode never
 * writes: it reads the checked-in workflow and fails unless every gate below
 * runs in an unconditional step of an unconditional job, and every id in
 * `requiredJobs` names a job that still runs unconditionally. `write` mode is
 * not reachable from here, and would be a downgrade — the render model has no
 * `needs`, `permissions`, `strategy`, job `environment`, step `if`, or
 * comments, and this file carries 60+ load-bearing comment lines.
 *
 * `continue-on-error` is deliberately ignored. A gate asserts that a command
 * still runs, not that its failure blocks a merge, so the advisory macOS,
 * Windows, and shadow lanes satisfy the gates they carry. A workflow-level
 * `if:` is treated the other way, because GitHub may skip the job or step.
 *
 * The `test` job's `Workflow contract` step runs this target. Before that step
 * existed the contract was inert: `docs '//...'` selects no root target, and
 * the shadow lane's `//packages/...` pattern excludes every `//:` label, so
 * nothing in CI ever planned `//:ci`.
 *
 * The roster is the hand-written gate surface, not the whole file. Steps that
 * only prepare a runner — checkout, `pnpm/action-setup`, `actions/setup-node`,
 * `Swatinem/rust-cache` — carry no gate and are not declared. The three
 * `uses:` entries that do carry one are here: actionlint validates the
 * workflows, `taiki-e/install-action` puts the pinned jj on PATH for the host
 * contract suites, and `oven-sh/setup-bun` pins the runtime the `bun` job
 * measures.
 */
export const ci = Smithers.GithubCiGen({
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  kinds: ["build", "test", "lint", "docs"],
  requiredJobs: ["test", "rust", "wasm-repro", "bun", "browser"],
  gates: [
    { name: "workflow validation", command: "docker://rhysd/actionlint:1.7.11", job: "test" },
    { name: "lockfile install", command: "pnpm install --frozen-lockfile --ignore-scripts", job: "test" },
    { name: "pinned jj toolchain", command: "taiki-e/install-action", job: "test" },
    { name: "colocated jj repository", command: "jj git init --colocate", job: "test" },
    { name: "typecheck", command: "pnpm run check", job: "test" },
    { name: "lint", command: "pnpm run lint", job: "test" },
    { name: "documentation parity", command: "pnpm exec smthrs docs '//...'", job: "test" },
    { name: "workflow contract", command: "pnpm exec smthrs lint '//:ci'", job: "test" },
    { name: "circular-dependency guard", command: "pnpm run circular", job: "test" },
    { name: "browser bundle guard", command: "pnpm run browser", job: "test" },
    { name: "release manifest unit test", command: "node --test scripts/pack-release.test.mjs", job: "test" },
    { name: "release rehearsal unit test", command: "node --test scripts/release-rehearsal.test.mjs", job: "test" },
    { name: "release version coherence", command: "node --test scripts/set-release-version.test.mjs", job: "test" },
    { name: "disaster-recovery script test", command: "node --test scripts/flows-backup.test.mjs", job: "test" },
    { name: "test-pin register guard", command: "node --test scripts/check-test-pins.test.mjs", job: "test" },
    { name: "workspace test suites", command: "pnpm test", job: "test" },
    { name: "clean rebuild", command: "pnpm --recursive --if-present run build", job: "test" },
    { name: "release pack", command: "node scripts/pack-release.mjs", job: "test" },
    { name: "release smoke test", command: "node scripts/smoke-release.mjs", job: "test" },
    { name: "pinned rust toolchain", command: "rustup toolchain install", job: "rust" },
    { name: "rust formatting", command: "cargo fmt --check", job: "rust" },
    { name: "rust lint", command: "cargo clippy --all-targets --locked -- -D warnings", job: "rust" },
    { name: "rust test suite", command: "cargo test --locked", job: "rust" },
    { name: "wasm build-script unit tests", command: "node --test crates/flows-jj/build-wasm.test.mjs", job: "wasm-repro" },
    { name: "wasm rebuild from source", command: "node crates/flows-jj/build-wasm.mjs", job: "wasm-repro" },
    { name: "wasm byte comparison", command: "cmp", job: "wasm-repro" },
    { name: "pinned bun runtime", command: "oven-sh/setup-bun", job: "bun" },
    {
      name: "bun-compatible suites",
      command: "bun node_modules/vitest/vitest.mjs run --coverage.enabled=false",
      job: "bun"
    },
    { name: "browser bundle gate", command: "pnpm run browser", job: "browser" }
  ]
})

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage
})
