# Nx for the flows workspace

This document describes the Nx setup on the `build-compare/nx` branch and
compares it against the in-repo build system (`BUILD.ts`,
`packages/targets`, `packages/build`, `packages/build-cli`). It is written
for a reader evaluating both systems side by side. Every claim about
behavior was verified by running the tool in this worktree; where something
does not work, the document says so and why.

Nx version: 23.1.1 (`nx@latest` at time of writing). Package manager: pnpm
11.21.0, unchanged.

## 1. What was added, file by file

| Path | Responsibility |
| --- | --- |
| `nx.json` | The whole workspace configuration: `namedInputs`, `targetDefaults`, plugin registrations, and the `nx release` config. |
| `.nxignore` | Keeps `vendor/jj` (a git submodule), `target/`, `.flows/`, and agent scratch out of Nx's file index and input hashing. |
| `tools/nx/package.json` | Makes `tools/nx` a local Nx plugin package (`@flows/nx-plugin`). Not a pnpm workspace member; Nx loads it by path. |
| `tools/nx/plugin.ts` | Inference plugin. Reads `smthrs.group` from every package manifest and emits `group:engine|agent|tooling` project tags, plus `type:package` / `type:app`. Infers a cacheable `fmt` target (`dprint check`) from the presence of `dprint.json`. |
| `tools/nx/generators.json`, `tools/nx/generators/new-package/*` | The `new-package` generator: the Nx equivalent of the `NewPackage` rule. See section 2, "Macros and target expansion". |
| `eslint.boundaries.js` | Shared flat-config block enabling `@nx/enforce-module-boundaries` with the tier constraints. Imported by every package config. |
| `packages/*/eslint.config.js` (45 files) | One import and one spread each, appending `moduleBoundaries` to the existing config. No rule changes. |
| `crates/flows-jj/project.json` | The only hand-written project file. Models the Cargo gates (`cargo-fmt`, `cargo-clippy`, `cargo-test`) and the wasm reproducibility gate (`wasm-repro`) as Nx targets with explicit inputs. |
| `.github/workflows/nx.yml` | The CI lane: `nx-set-shas`, `nx affected -t check,lint,fmt,circular,test,build`, local-cache restore via `actions/cache`, wired for Nx Cloud when a token exists. |
| `package.json` (root) | Adds `nx`, `@nx/js`, `@nx/vite`, `@nx/vitest`, `@nx/eslint`, `@nx/eslint-plugin`, `@nx/devkit`, `@nx/workspace` as dev dependencies, all 23.1.1. |
| `pnpm-lock.yaml` | Lockfile for the above. |

Nothing existing was deleted or rewritten. The pnpm scripts, `BUILD.ts`,
`ci.yml`, and `release.yml` are untouched; the Nx lane runs alongside them.

### What each plugin does here

- `@nx/vitest` (scoped to `packages/**`): infers test targets from
  `vitest.config.ts`. In this workspace the package.json `test` script wins
  the name collision (Nx 23 keeps the script target), so the plugin's value
  is configuration awareness, not the command. Atomization (`ciTargetName`)
  was evaluated and rejected; see section 4.
- `@nx/vite` (scoped to `packages/**`): no package carries a `vite.config.*`,
  so it currently infers nothing. It is registered so a future library with a
  Vite build gets `build`/`dev` targets without config. It is scoped away
  from `apps/**` because the plugin boots the Vite config through Node ESM at
  graph time, and the apps use bundler-style extensionless imports
  (`moduleResolution: bundler`) that Node cannot resolve. `apps/ui` keeps its
  script targets.
- `@nx/js/typescript`: registered with target inference disabled
  (`typecheck: false, build: false`). Its inferred targets and its sync
  generator assume the TypeScript solution-style layout (composite projects,
  references, declaration-based cross-project resolution). This workspace
  resolves cross-package imports to source (`exports: { ".": "./src/index.ts" }`)
  and has zero project references by design. See section 4 for what
  `nx sync` does here.
- `@nx/eslint`: **not registered.** Its inferred command is hard-coded to
  `eslint .`, and these flat configs deliberately cover only `src`
  (`packages/targets/src/StandardPackage.ts` documents why: ESLint 9 fails on
  patterns whose matches are unconfigured, and `scripts/*.mjs` and the config
  file itself are intentionally outside the linted surface). Verified:
  `eslint .` in `packages/core` fails with parse errors on
  `eslint.config.js` and `scripts/*.mjs`. The `lint` targets therefore come
  from the package.json scripts (`eslint src --max-warnings=0 && dprint
  check`), which is the actual gate. The Nx-specific lint value — the
  boundary rule — is wired through `eslint.boundaries.js` instead.
- `./tools/nx`: the local plugin described above.

## 2. How Nx models what `BUILD.ts` models

### Target definition

`BUILD.ts`: a target is a typed TypeScript value (`Smithers.TsBuild`,
`Smithers.Vitest`, …) with declared inputs, a declared toolchain, and a
label (`//packages/core:lib`).

Nx: a target is a JSON entry. Three sources merge into one project
configuration: package.json scripts (Nx runs them with `nx:run-script`),
inference plugins (`createNodesV2`), and `targetDefaults` in `nx.json`.
Example: `@smthrs/core:check` is the package's `check` script, made
cacheable by `targetDefaults.check` with `inputs: ["default", "^default"]`.

The important semantic difference: a `BUILD.ts` target is a value a rule
constructed, so its inputs and command are type-checked against the rule's
schema. An Nx target is configuration; nothing type-checks that
`inputs: ["production"]` actually covers what `node scripts/build.mjs`
reads. Nx's answer to that is inference plugins (the plugin author got the
inputs right once) — which works when the repo matches the plugin's
assumptions, and does not when it does not (section 4).

### The toolchain

`BUILD.ts`: `Smithers.Runtime.Node({ version })` and
`Smithers.PackageManager.Pnpm({ version, runtime })` are values threaded
into every target; the Runtime service refuses to execute on a
non-conforming host.

Nx has no toolchain model. Targets run whatever `node`, `pnpm`, `tsc`, and
`cargo` are on `PATH`. Version enforcement stays where it is today:
`package.json` `engines`, the `packageManager` field, and
`rust-toolchain.toml`. Nx neither checks nor provisions them. The cache key
does not include the toolchain either: a target's hash covers inputs,
command, and Nx's own version, not the Node or TypeScript version that
produced the outputs. `externalDependencies` inputs (which the vitest plugin
emits) hash the *resolved installed version* of a named dependency, which
covers Vitest itself but not the interpreter.

### Inputs, outputs, and cache keys

`BUILD.ts`: inputs are declared per rule as typed globs; the key covers the
declared toolchain, the generated lockfile, and the input file set.

Nx: `namedInputs` in `nx.json`. This workspace defines:

- `sharedGlobals`: `tsconfig.base.json`, `eslint.jsdoc.js`,
  `eslint.boundaries.js`, `pnpm-workspace.yaml`, `rust-toolchain.toml` — the
  root files that invalidate everything. (Verified live: reverting
  `pnpm-workspace.yaml` re-hashed and re-ran all 51 test tasks.)
- `default`: `{projectRoot}/**/*` plus `sharedGlobals`.
- `production`: `default` minus `test/**`, `*.test.ts`, `*.spec.ts`,
  `tsconfig.test.json`, `vitest.config.ts`, `eslint.config.js`,
  `dprint.json`, and `*.md`.

`build` uses `["production", "^production"]` with `outputs:
["{projectRoot}/dist"]`. `check`, `lint`, `test`, `circular` use
`["default", "^default"]` — dependency *sources* must be in the key because
cross-package imports resolve to source, not to built declarations. This is
the inverse of the standard Nx workspace, where `^production` suffices
because dependencies are consumed from `dist`. Getting this wrong here
would be a silent stale hit, and it is exactly the class of mistake that is
invisible until it bites: Nx will not warn that a typecheck read a file
outside its declared inputs.

One Nx behavior to know: files ignored by `.gitignore`/`.nxignore` are
excluded from hashing, so `dist/` does not invalidate `check`.

### Macros and target expansion across 45 packages

`BUILD.ts`: `Smithers.PackageDefaults({ directories: "packages/*", macro:
Smithers.StandardPackage })` expands one glob into six targets per package,
no per-package file.

Nx: the equivalent is inference plus `targetDefaults`, and it covers the
same ground with no per-package file: 45 packages get `check`, `lint`,
`test`, `build`, `circular`, `coverage` from their identical scripts,
`fmt` from the local plugin, and release wiring from `@nx/js`. Verified with
the generator: `nx g ./tools/nx:new-package` scaffolds a package that
passes `check, lint, fmt, test, build` immediately with zero Nx-specific
files — the same "no BUILD.ts for a standard package" property the
`NewPackage` rule documents.

The `new-package` generator (`tools/nx/generators/new-package/generator.ts`)
reads its manifest shape — script set, exports, publishConfig, pinned
devDependency versions — from an existing sibling at generation time, so
the scaffold cannot drift from the fleet's pinned versions. The
`NewPackage` rule embeds its template instead; both are one-source-of-truth
answers to the same problem.

### Generated-file drift checks

`BUILD.ts`: `pnpm-workspace.yaml`, the workspace `tsconfig.json`, and
`pnpm-lock.yaml` are *outputs* of targets, drift-checked against the tree.

Nx has no equivalent for arbitrary files. Its one drift mechanism is sync
generators (`nx sync:check`), and the only shipped one is
`@nx/js:typescript-sync`, which synchronizes TypeScript project references
with the project graph. This workspace has no project references, so the
generator is moot here — and worse than moot: `nx sync:check` reports every
project as a missing root-tsconfig reference, while `nx sync` writes
`"references": []` (its composite filter drops every project), leaving the
check permanently red. Wiring it as a gate would require converting all 45
packages to composite solution-style projects — a change to the repo's
build semantics, not to its Nx config. The generator was detached and this
is called out rather than hidden.

`pnpm-lock.yaml` drift is covered incidentally: `pnpm install
--frozen-lockfile` in CI fails on drift, and Nx hashes external dependency
versions into task keys.

### Secrets

`BUILD.ts`: `Smithers.Secret("SMITHERS_CACHE_TOKEN")` declares the variable
name; a substituting proxy injects the value at execution time, so key
material records the name and never the value.

Nx: secrets are environment variables, full stop. `NX_CLOUD_ACCESS_TOKEN`
is read from the environment; nothing records which targets need it,
nothing prevents a target command from echoing it, and it is not part of
any cache key. The nx.yml workflow passes it through explicitly. This is
strictly weaker than the proxy model — there is no declaration site to
audit.

### `node_modules` as a dependency

`BUILD.ts`: `Smithers.Install` makes `node_modules` a target keyed on the
toolchain and the generated lockfile; every tool-running target depends on
it.

Nx: `node_modules` is ambient. Tasks assume it exists. The cache key covers
`externalDependencies` versions where a plugin declares them, but there is
no install task in the graph and no way to express "this target needs the
store populated." In CI this is fine (the install step precedes `nx`), but
it means `nx build` on a fresh clone fails with tool-not-found rather than
installing first.

## 3. Where Nx is genuinely better

- **`nx affected`**. The headline feature, and it works. Measured on this
  repo: a one-line change to `packages/crypto/src/index.ts` selects 51 of
  52 projects (crypto is a transitive dependency of nearly everything —
  an accurate blast radius, and itself a useful signal). A change to a leaf
  package selects that package alone. Our system has no change-impact
  analysis; CI runs the full gate surface every time.
- **Cache ergonomics**. `cache: true` plus `inputs`/`outputs` per target
  name, with daemon, terminal UI, and `nx reset`. Measured here: 123-task
  check/fmt/circular surface drops from 1m42s cold to 1.1s warm; 51 test
  tasks from 2m48s to 209ms. The in-repo system's remote cache
  (`packages/build/infra`) is a whole Worker + terraform deployment we
  operate ourselves; Nx Cloud is a paid SaaS, but the local cache is free
  and immediate.
- **The project graph as a product**. `nx graph` renders the 52-project
  dependency graph from the same data the scheduler uses. Our system has
  the graph but no visualization.
- **Module boundaries as lint**. `@nx/enforce-module-boundaries` turned
  `smthrs.group` into an enforced rule with a two-line import per package.
  It also immediately found two things the repo's own gates miss: a
  cross-package runtime cycle (`@smthrs/kernel` ⇄
  `@smthrs/platform-browser`, allowlisted in `eslint.boundaries.js`) and
  the dev-time cycles through `BUILD.ts` files. The repo's madge guard only
  sees per-package cycles.
- **`nx release`** covers version bumping from conventional commits, fixed
  release groups, internal range retargeting (`updateDependents: auto`),
  changelogs, and publish ordering. `release.yml` hand-rolls the same
  pipeline in bash; the dry-run output of both is comparable.
- **Ecosystem and documentation**. `nx migrate` updates the tool itself;
  generators, executors, and plugin APIs are documented and versioned. Our
  rule catalog is ours to document and maintain forever.

## 4. Where Nx cannot express what our system expresses

- **The toolchain as a value**. There is no way to declare "every target
  runs Node >=22.19.0 under pnpm 11.21.0" and have the scheduler enforce
  it. Cache keys do not include interpreter or compiler versions. A
  Node-version change can hit a stale cache. Our system refuses to execute
  on a non-conforming host; Nx cannot say this at all.
- **Generated root files as graph outputs**. `pnpm-workspace.yaml` and the
  workspace `tsconfig.json` as drift-checked target outputs have no Nx
  equivalent. Sync generators are the closest mechanism, and the one
  shipped generator (typescript-sync) is hard-bound to the solution-style
  TS layout this repo does not use. Writing a custom sync generator for
  `pnpm-workspace.yaml` is possible (the API exists) but it would be our
  code either way.
- **Secrets with a declaration site**. Section 2. Nx has nothing like
  `Smithers.Secret`.
- **Install as a target**. Section 2. There is no way to make
  `node_modules` a node in the task graph.
- **Typed target construction**. Nx config is JSON validated by a JSON
  schema. `BUILD.ts` is TypeScript: rule options are checked by `tsc`,
  JSDoc is on every attr, and a wrong attr is a compile error, not a
  runtime surprise. With Nx, a wrong `inputs` entry is a silent cache
  miss or a silent stale hit, found by nobody.
- **Atomization with suite-level coverage gates** (tried, rejected). The
  `@nx/vitest` atomizer generates one target per test file
  (`vitest run <file>`). In this repo, packages with
  `coverage.enabled: true` enforce thresholds over the whole suite, so an
  atomized single-file run fails its own coverage gate. The atomizer also
  bakes the config's `reportsDirectory` into target outputs at graph time;
  these configs use `join(tmpdir(), ...-${process.pid})`, which produced
  outputs like `{workspaceRoot}/../../../../tmp/flows-core-coverage-54087`
  — an escaping path with a dead PID. `ciTargetName` is not configured;
  the PR body shows the evidence.
- **`@nx/eslint` inference with scoped flat configs** (tried, rejected).
  Section 1. The inferred command is `eslint .` and cannot be overridden
  without a per-project file.
- **The wasm reproducibility gate is expressible, barely.** It is a
  command target in `crates/flows-jj/project.json` with `cache: false` —
  caching is deliberately off because the gate exists to prove the rebuild
  reproduces the committed bytes on *this* host; a remote cache hit from a
  different host would mask exactly the nondeterminism the gate catches.
  That reasoning had to be done by hand; Nx's model ("cache everything with
  correct inputs") is sound but silent about host-provenance. The gate only
  runs on `x86_64-unknown-linux-gnu` (the script refuses other hosts), so
  it is verified here by inspection and by `nx show project`, not by
  execution on this Mac.

## 5. What it costs

- **Dependencies**: 8 new root devDependencies (`nx` + 7 `@nx/*` packages),
  23.1.1 each. The install adds roughly 1,300 packages to the store. The
  version lockstep matters: mixed `@nx/*` versions are a classic failure
  mode, and `nx migrate` is the supported upgrade path.
- **Config surface**: `nx.json` (190 lines), `.nxignore`,
  `crates/flows-jj/project.json`, `eslint.boundaries.js`, a local plugin,
  a generator, and one import line in 45 eslint configs. Smaller than the
  rule catalog it shadows, but it is a second build system living next to
  the first.
- **The daemon**: Nx runs a background daemon per workspace for graph
  caching and file watching. It is a long-lived process holding a socket
  and a file watcher; on this machine it has been invisible, but it is a
  moving part our system does not have, and `nx reset` exists because the
  daemon's cache can go stale.
- **Lock-in**: `namedInputs`, `targetDefaults`, inference plugins, sync
  generators, and the release config are all Nx concepts. The package.json
  scripts remain the actual commands, so backing out costs deleting the
  added files — moderate. Deep adoption (Nx executors everywhere, Nx Cloud,
  atomized CI) would raise that cost sharply.
- **Distributed execution requires Nx Cloud**. `nx affected` works anywhere;
  distributing tasks across agents and sharing a remote cache is an Nx
  Cloud feature (self-hostable as an enterprise product). The free tier
  covers small teams, but the architecture answer "our cache, our infra"
  that `packages/build/infra` embodies is not available in the OSS Nx
  world; the community S3/GCS cache plugins are unofficial. nx.yml uses the
  local cache via `actions/cache` and is wired for Nx Cloud with one
  missing secret (`NX_CLOUD_ACCESS_TOKEN`) plus one command (`pnpm exec nx
  connect`) a human must run to create the workspace and write `nxCloudId`.
- **Graph-time config evaluation**. The inference plugins boot Vite and
  read every tsconfig while building the project graph. In this repo that
  forced scoping `@nx/vite`/`@nx/vitest` away from `apps/**` (extensionless
  imports crash Node ESM resolution). Graph construction on a cold daemon
  adds seconds to every invocation.

## 6. What adoption would involve

1. Land this branch. Existing gates are unaffected (verified: the five
   `node --test` script gates, the browser gate, and the pnpm recursive
   check/lint/test/build scripts behave identically; the 14 `dprint check`
   README failures and the missing `smthrs` bin reproduce byte-identically
   on a pristine `origin/main` checkout, so they are pre-existing, not
   caused by this branch).
2. Decide the source of truth for lint. Either keep script-based lint
   (this branch) or refactor the flat configs so `eslint .` is valid and
   register `@nx/eslint`. The former is zero work; the latter makes the
   eslint plugin useful but touches every package config again.
3. Decide on Nx Cloud. Without it, CI caching is `actions/cache` over
   `.nx/cache` (works, coarse). With it: `pnpm exec nx connect`, add the
   `NX_CLOUD_ACCESS_TOKEN` secret, and nx.yml is already wired.
4. Move `ci.yml`'s check/lint/test/build steps to `nx affected` gradually:
   run the nx.yml lane in advisory mode until its verdicts match the pnpm
   gates for a few weeks (the same adoption pattern the repo already uses
   for its own `smthrs-shadow` lane), then flip which one is required.
5. If `nx release` is adopted for the engine train, rehearse it against a
   next-tag the way `release.yml`'s dry-run path does, and retire the bash
   publish plan only after a real tag publishes the same set in the same
   order. `scripts/pack-release.mjs` and the staging-manifest smoke test
   stay either way — Nx publishes what `npm publish` would, it does not
   repack.
6. Do not adopt: solution-style project references (breaks source-first
   resolution), test atomization (breaks coverage gates), or
   `eslint .` inference (breaks the scoped lint surface) — unless the repo
   changes the underlying conventions first.

### Measured numbers (this worktree, M-series Mac, `--parallel=2` for test, 4 otherwise)

| Surface | Cold | Warm (100% cache hits) |
| --- | --- | --- |
| `check` + `fmt` + `circular` (123 tasks, 47 projects) | 1m42s | 1.1s |
| `build` (44 projects) | 43.7s | ~1s |
| `test` (51 projects) | 2m48s | 209ms |
| `nx affected` on `packages/crypto/src/index.ts` | 51 of 52 projects selected | — |
