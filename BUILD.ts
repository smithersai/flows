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

// ---------------------------------------------------------------------------
// GitHub automation
// ---------------------------------------------------------------------------

/**
 * The model credential the factory's agent jobs run on.
 *
 * It reaches a job only through a `GithubAutomation` job that declares it, and
 * the renderer refuses to place it in a job marked `untrustedInput`. The
 * PoC-execution job is exactly such a job, which is why the loop is split into
 * an authoring job that holds the key, a sandbox that holds none, and a
 * publishing job that holds the key again.
 */
export const anthropicKey = Smithers.Secret("ANTHROPIC_API_KEY")

/**
 * The release pipeline's gate surface, verified in place.
 *
 * `.github/workflows/release.yml` is hand-written for the same reason `ci.yml`
 * is: it carries a rehearsal path, an environment binding, and a publish loop
 * no declaration reproduces. Contract mode reads it and fails when a gate stops
 * running. The roster is release.yml's own stated invariant — it must stay a
 * superset of ci.yml's — written down where a check can enforce it.
 */
export const release = Smithers.GithubCiGen({
  packageManager,
  output: ".github/workflows/release.yml",
  requiredJobs: ["publish"],
  gates: [
    { name: "workflow lint", command: "docker://rhysd/actionlint:1.7.11", job: "publish" },
    { name: "typecheck", command: "pnpm run check", job: "publish" },
    { name: "tests", command: "pnpm test", job: "publish" },
    { name: "lint", command: "pnpm run lint", job: "publish" },
    { name: "circular-dependency guard", command: "pnpm run circular", job: "publish" },
    { name: "browser bundle guard", command: "pnpm run browser", job: "publish" },
    { name: "release manifest unit test", command: "node --test scripts/pack-release.test.mjs", job: "publish" },
    { name: "release rehearsal unit test", command: "node --test scripts/release-rehearsal.test.mjs", job: "publish" },
    { name: "test-pin register guard", command: "node --test scripts/check-test-pins.test.mjs", job: "publish" },
    { name: "release pack", command: "node scripts/pack-release.mjs", job: "publish" },
    { name: "release smoke test", command: "node scripts/smoke-release.mjs", job: "publish" }
  ]
})

/** Attributes every generated automation workflow shares. */
const automation = { packageManager, nodeVersion: "22.19.0" }

/**
 * The workflow token, for the `gh` CLI the automation entries shell out to.
 *
 * It is `env`, not a declared secret, because it is minted per run by GitHub
 * rather than stored in the repository. The renderer treats it as a credential
 * all the same and refuses it on any `untrustedInput` job, which is why the
 * sandbox job below does not carry it.
 */
const githubToken = { GH_TOKEN: "${{ github.token }}" }

/**
 * Intake: decode a new report, look for duplicates, comment with candidates.
 *
 * The job is trusted — it holds the model credential and writes to the issue —
 * so it runs behind the maintainer gate. It never executes anything the
 * reporter wrote; it reads the issue and searches the memory corpus.
 */
export const issueIntake = Smithers.GithubAutomation({
  ...automation,
  slug: "issue-intake",
  target: "issueIntake",
  workflowName: "Issue intake",
  on: { issues: ["opened", "edited"] },
  concurrency: "gen-issue-intake-${{ github.event.issue.number }}",
  jobs: [
    Smithers.Automation.agent({
      id: "intake",
      name: "decode, dedupe, and comment",
      entry: "intake.ts",
      requireApproval: true,
      timeoutMinutes: 20,
      permissions: { contents: "read", issues: "write" },
      secrets: [anthropicKey],
      env: githubToken
    })
  ]
})

/**
 * The PoC loop: author a repro, run it in a sandbox, post it to the reporter.
 *
 * The three jobs exist because of one rule. `execute` runs steps derived from
 * the reporter's own description, so it is declared `untrustedInput` and the
 * renderer strips it of every credential and every write permission. It can
 * therefore only publish an artifact; `publish` reads that artifact and does
 * the talking.
 */
export const pocLoop = Smithers.GithubAutomation({
  ...automation,
  slug: "poc-loop",
  target: "pocLoop",
  workflowName: "Repro PoC loop",
  on: { issues: ["labeled"], workflowDispatch: true },
  concurrency: "gen-poc-loop-${{ github.event.issue.number }}",
  jobs: [
    Smithers.Automation.agent({
      id: "author",
      name: "write the repro pair",
      entry: "poc.ts",
      requireApproval: true,
      timeoutMinutes: 30,
      permissions: { contents: "write", issues: "read" },
      secrets: [anthropicKey],
      env: githubToken,
      uploads: [{ name: "poc", path: "factory/repros" }]
    }),
    Smithers.Automation.agent({
      id: "execute",
      name: "run the repro in a no-secrets sandbox",
      entry: "poc-run.ts",
      untrustedInput: true,
      needs: ["author"],
      timeoutMinutes: 30,
      downloads: [{ name: "poc", path: "factory/repros" }],
      uploads: [{ name: "poc-result", path: "factory/repros/result.json" }]
    }),
    Smithers.Automation.agent({
      id: "publish",
      name: "post the PoC and ask the reporter",
      entry: "poc-publish.ts",
      requireApproval: true,
      needs: ["execute"],
      timeoutMinutes: 15,
      permissions: { contents: "read", issues: "write" },
      secrets: [anthropicKey],
      env: githubToken,
      downloads: [{ name: "poc-result", path: "factory/repros" }]
    })
  ]
})

/**
 * Reporter replies advance the state labels.
 *
 * A comment is untrusted text, but this job only classifies it and moves a
 * label, so it holds the credential and runs behind the gate rather than in the
 * sandbox. Nothing it reads is executed.
 */
export const issueReply = Smithers.GithubAutomation({
  ...automation,
  slug: "issue-reply",
  target: "issueReply",
  workflowName: "Repro state machine",
  on: { issueComment: ["created"] },
  concurrency: "gen-issue-reply-${{ github.event.issue.number }}",
  jobs: [
    Smithers.Automation.agent({
      id: "advance",
      name: "advance the repro state",
      entry: "advance.ts",
      requireApproval: true,
      timeoutMinutes: 15,
      permissions: { contents: "write", issues: "write" },
      secrets: [anthropicKey],
      env: githubToken
    })
  ]
})

/**
 * The proof gate: a fix PR's repro must fail at the merge base and pass at the
 * head.
 *
 * It builds and runs the pull request's own code, so it is `untrustedInput`
 * and holds nothing. A fork PR from outside the organization runs it only once
 * a maintainer applies the approval label, which is the intended fail-closed
 * behaviour for a job that executes a stranger's test.
 */
export const reproProof = Smithers.GithubAutomation({
  ...automation,
  slug: "repro-proof",
  target: "reproProof",
  workflowName: "Repro proof gate",
  on: { pullRequest: ["opened", "synchronize", "reopened", "labeled"] },
  concurrency: "gen-repro-proof-${{ github.event.pull_request.number }}",
  jobs: [
    Smithers.Automation.agent({
      id: "proof",
      name: "fail at the merge base, pass at the head",
      entry: "proof.ts",
      untrustedInput: true,
      timeoutMinutes: 45
    })
  ]
})

/**
 * Rubric review over a pull request diff, posted as one review.
 *
 * The job reads the diff and calls the model; it does not run the diff, so it
 * keeps its credential and runs behind the gate.
 */
export const prReview = Smithers.GithubAutomation({
  ...automation,
  slug: "pr-review",
  target: "prReview",
  workflowName: "Pull request review",
  on: { pullRequest: ["opened", "synchronize", "reopened", "ready_for_review"] },
  concurrency: "gen-pr-review-${{ github.event.pull_request.number }}",
  jobs: [
    Smithers.Automation.agent({
      id: "review",
      name: "rubric review over the diff",
      entry: "review.ts",
      requireApproval: true,
      timeoutMinutes: 45,
      permissions: { contents: "read", "pull-requests": "write" },
      secrets: [anthropicKey],
      env: githubToken
    })
  ]
})

/**
 * A verified repro becomes a queue item, a lane, and a pull request.
 *
 * This is the one job that opens a pull request on its own, so it is the one
 * that most needs the maintainer gate. It runs on a label event and re-reads
 * the issue's labels itself rather than trusting the event payload.
 */
export const verifiedFix = Smithers.GithubAutomation({
  ...automation,
  slug: "verified-fix",
  target: "verifiedFix",
  workflowName: "Verified repro to pull request",
  on: { issues: ["labeled"], workflowDispatch: true },
  concurrency: "gen-verified-fix-${{ github.event.issue.number }}",
  jobs: [
    Smithers.Automation.agent({
      id: "fix",
      name: "queue the item, run the lane, open the pull request",
      entry: "fix.ts",
      requireApproval: true,
      timeoutMinutes: 120,
      permissions: { contents: "write", issues: "write", "pull-requests": "write" },
      secrets: [anthropicKey],
      env: githubToken
    })
  ]
})

/**
 * The scheduled sweep: unpark blocked repros, re-run verified ones, close the
 * ones that no longer reproduce.
 *
 * A schedule has no untrusted actor, so this job needs no gate. It is the only
 * automation that runs without one.
 */
export const reproReverify = Smithers.GithubAutomation({
  ...automation,
  slug: "repro-reverify",
  target: "reproReverify",
  workflowName: "Repro re-verification sweep",
  on: { schedule: ["17 4 * * *"], workflowDispatch: true },
  concurrency: "gen-repro-reverify",
  jobs: [
    Smithers.Automation.agent({
      id: "reverify",
      name: "re-run parked and verified repros against main",
      entry: "reverify.ts",
      timeoutMinutes: 120,
      permissions: { contents: "write", issues: "write" },
      secrets: [anthropicKey],
      env: githubToken
    })
  ]
})
