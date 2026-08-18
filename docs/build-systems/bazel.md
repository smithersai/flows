# Bazel for the flows workspace

This document is the comparison reference for the Bazel PR. It describes what
was added, how Bazel models the same things the in-repo `BUILD.ts` system
models, what Bazel provides that neither Nx nor Turborepo can, where Bazel's
model fights this repository, what it costs, and what a migration would
involve.

A naming note first. This repository already has files named `BUILD.ts` at the
root and in some packages. They belong to the in-repo smithers build system
and have nothing to do with Bazel. Bazel loads only files named `BUILD` or
`BUILD.bazel`, so there is no collision. The Bazel setup uses `BUILD.bazel`
everywhere so a reader is never confused. No `BUILD.ts` file was modified or
deleted.

All measurements below were taken on an Apple Silicon MacBook Pro (darwin-arm64)
with Bazel 8.7.0 under bazelisk, on 2026-08-18.

## 1. What was added, file by file

| File | Responsibility |
| --- | --- |
| `.bazelversion` | Pins Bazel 8.7.0 for bazelisk. 9.2.0 is the current release line; 8.7.0 is the newest 8.x LTS and the line the Aspect rules and rules_rust test against. |
| `MODULE.bazel` | The bzlmod module. Pins `aspect_rules_js` 3.4.0, `aspect_rules_ts` 3.10.0, `aspect_rules_lint` 2.7.2, `aspect_gazelle_prebuilt` 0.0.24, `rules_nodejs` 6.7.5, `rules_rust` 0.73.0, `bazel_skylib` 1.9.2, `platforms` 1.1.0, `rules_multirun` 0.14.0. Declares the hermetic Node 22.19.0 toolchain, hermetic pnpm 11.21.0, `npm_translate_lock` over `pnpm-lock.yaml`, the TypeScript toolchain (version read from `packages/canonical/package.json` so it cannot drift from the pnpm side), and the Rust 1.89.0 toolchain with the `wasm32-wasip1` target. |
| `MODULE.bazel.lock` | The committed bzlmod lockfile. Bazel verifies it on every run. |
| `.bazelrc` | `common --enable_bzlmod`, `common --enable_workspace=false` (bzlmod-only), `build --disk_cache=%workspace%/.bazel-cache` (a valueless `--disk_cache` is a trap: rc files are one token stream, so it consumes the next flag as its path; the path is explicit and gitignored), sandboxing flags stated explicitly, a `--config=remote` section (Build without the Bytes via `--remote_download_toplevel`), a `--config=ci` section, and a `--config=lint` section that attaches the ESLint aspect. |
| `.bazelignore` | Every workspace importer's `node_modules`, plus `docs` and `evals`. `npm_translate_lock` verifies this list (`verify_node_modules_ignored`). |
| `BUILD.bazel` (root) | `npm_link_all_packages` for the root manifest, the `gazelle` target and its JS-plugin directives, the `gazelle.check` drift gate, the shared `eslint_jsdoc` js_library, and the root aggregator `eslint_config`. |
| `eslint.config.js` (root, new) | Aggregator flat config the lint aspect discovers from the bin root. Imports each wired package's own `eslint.config.js` with `files` globs re-scoped. Not consulted by per-package `pnpm run lint`. |
| `packages/canonical/BUILD.bazel`, `packages/crypto/BUILD.bazel`, `packages/keys/BUILD.bazel` | The migrated slice. Each carries Gazelle-maintained scaffolding (`npm_link_all_packages`, two `ts_config` rules) and hand-maintained targets: `ts` (ts_project library build), `ts_tests` (ts_project test typecheck), `test` (coverage-gated Vitest), `sources` and `package_sources` filegroups, `pkg` (npm_package, publishable, with a `pkg.publish` release target), and `eslint_config` (js_library wrapping the package's flat config and plugin closure). |
| `packages/*/BUILD.bazel`, `apps/*/BUILD.bazel`, `examples/BUILD.bazel` (49 files, generated) | Gazelle-generated package-level scaffolding for every other workspace package: `npm_link_all_packages`, `ts_config` rules, and `pkg` where another package depends on it. Source-directory generation is disabled repo-wide by a root directive (see section 4), so these files contain no ts_project targets yet. They build and are drift-checked. |
| `packages/jj/wasm/BUILD.bazel` | Exports the committed `flows_jj.wasm` artifact as the reference half of the reproducibility gate. |
| `crates/flows-jj/BUILD.bazel` | `flows_jj_wasm` (genrule producing the wasm32-wasip1 artifact), `cargo_test`, `clippy_test`, `rustfmt_test` (sh_tests running the pinned cargo in a sandbox), and `wasm_repro_test` (diff_test against the committed artifact). |
| `tools/vitest/defs.bzl` | The `vitest_test` macro: wraps the rules_js-generated `js_test` factory for the vitest binary, with `chdir` to the package and a `--coverage` flag. |
| `tools/js/defs.bzl` | `workspace_npm_package`, a thin macro over `npm_package` that opts the rule out of Gazelle management (Gazelle owns rules of kind `npm_package`; it does not touch kinds it does not know). |
| `tools/lint/BUILD.bazel`, `tools/lint/linters.bzl` | The ESLint js_binary from the npm graph and the rules_lint aspect definition. |
| `tools/format/BUILD.bazel`, `tools/format/dprint.sh` | `//tools/format` (`dprint fmt`) and `//tools/format:format.check` (`dprint check`) over the wired packages, via the dprint CLI from the npm graph. |
| `tools/platforms/BUILD.bazel` | The `wasm32-wasip1` target platform (cpu wasm32, os wasi). |
| `tools/cargo/vendor_jj.bzl` | Repository rule exposing the `vendor/jj` submodule tree as Bazel inputs (`@vendor_jj//:tree`). |
| `tools/cargo/registry.bzl` | Repository rule running `cargo fetch --locked` at fetch time into an offline `CARGO_HOME` (`@cargo_registry`). |
| `tools/cargo/cargo_action.sh` | The sandboxed cargo runner: reconstructs the workspace layout from declared inputs in a scratch directory and runs the pinned toolchain offline. |
| `.github/workflows/bazel.yml` | CI: bazelisk, warm caches, build, test, lint aspect, format check, Gazelle drift check, and the wasm reproducibility gate. |
| `.gitignore` | Adds `bazel-*` (Bazel's convenience symlinks). |
| `packages/{canonical,crypto,keys}/vitest.config.ts` | Adds `resolve.preserveSymlinks` when `TEST_SRCDIR` is set. Behavior under pnpm is unchanged. See section 4. |

## 2. How Bazel models what `BUILD.ts` models

The in-repo system is explicitly Bazel-inspired. This section walks the shared
concepts and states whether the in-repo system copied Bazel correctly.

### Target definition

Bazel: a target is an instance of a rule, declared in a `BUILD.bazel` file in
Starlark. The rule defines an attribute schema; the target binds attributes to
values; dependencies are labels of other targets. The graph is static after
loading.

In-repo: a target is a value returned by a rule function (`Target.make`,
`packages/targets/src/Target.ts:439`), declared in a `BUILD.ts` file in
TypeScript. Dependency edges and declared inputs are harvested by walking the
decoded attributes (`Target.ts:509-555`), which is a real ergonomic win: there
is no separate `deps` list to keep in sync, because any attribute holding
another target is a dependency. Bazel requires `deps` explicitly and relies on
Gazelle to keep them honest. The in-repo `//pkg:target` label grammar
(`packages/build-cli/src/Label.ts`) is copied directly from Bazel.

Verdict: copied correctly, with a nicer edge-inference mechanism Bazel cannot
have because Starlark BUILD files are not type-checked code.

### The toolchain

Bazel: toolchains are first-class. `node.toolchain(node_version = "22.19.0")`
and `rust.toolchain(versions = ["1.89.0"])` in `MODULE.bazel` make Bazel
download the interpreters; toolchain resolution matches them to platforms.
Nothing resolves `node` from `PATH`.

In-repo: `Smithers.Runtime.Node({version})` and
`Smithers.PackageManager.Pnpm({version, runtime})` are values threaded through
every target that runs a tool (`BUILD.ts:24-30`). At execution the runtime
service measures the host and refuses on mismatch
(`packages/build/src/Runtime.ts:135-154`).

Verdict: the in-repo model declares and verifies, but it *uses the host's
tools*; Bazel *fetches* them. The declaration shape was copied; the hermeticity
was not. This is the single largest hermeticity gap between the two systems,
and it is a design decision, not an oversight: downloading toolchains was out
of scope. Section 6 argues it should move into scope.

### Inputs, outputs, and cache keys

Bazel: every action declares its inputs (files and directories, as labels) and
outputs. The action key hashes the command line, the input digests, the
toolchain, and the platform. A cache hit restores outputs without executing.
Keys are content-addressed end to end.

In-repo: declared inputs are globs/files/git-diff sets
(`packages/targets/src/Input.ts`), digested as sha256 over contents. Key
material has four parts (body, inputs, layers, capabilities;
`packages/build-cli/src/Planner.ts:33-38`), including an
`implementationDigest` over the rule's function identities and a fingerprint
of the build system's own source bytes. Dependency keys substitute into
dependent keys by reference (`{_tag:"Target", key: depKey}`).

Verdict: copied correctly, and in one way exceeded: the in-repo key includes
the build system's own implementation bytes, so upgrading the build system
correctly invalidates every target. Bazel achieves the same through the action
key covering the rule's Starlark-level command construction and the tool
inputs. The in-repo divergence that matters: cache admission is opt-in per
rule (`cache` defaults to false, `Target.ts:495-501`), where Bazel caches
every action by default and opts out by exception. Several rules that should
be cacheable (`TsBuild`, the typechecks) currently are not admitted.

### Macros and target expansion across 45 packages

Bazel: macros are Starlark functions that expand to rules at loading time.
Expansion across directories is Gazelle's job: it walks the tree and generates
`BUILD.bazel` files from imports and manifests, and a drift check
(`bazel run //:gazelle.check`) fails CI when committed files are stale. In this
PR, Gazelle generates and maintains 50 `BUILD.bazel` files (every workspace
package's scaffolding, plus the root) covering the npm link targets, ts_config
rules, and pkg targets.

In-repo: `StandardPackage` is a plain TypeScript function returning six
targets; `PackageDefaults` applies it across a directory glob, so 45 packages
need no per-package file (`packages/targets/src/PackageDefaults.ts`,
`BUILD.ts:139-143`). Expansion happens in the workspace index at plan time.

Verdict: the in-repo `PackageDefaults` is genuinely better for uniform trees:
one declaration covers every package, and there is nothing to drift. Bazel
cannot do this; its answer is generation plus a drift gate, which this PR
wires and which works, but which means 45 generated files that must be
committed and kept fresh. The in-repo system traded Bazel's explicitness for
synthesis, and for a uniformly-shaped workspace that trade looks right. The
cost shows up in the divergence from Bazel's query model: Bazel can answer
`bazel query 'deps(//packages/keys:ts)'` without running anything; the in-repo
system must evaluate TypeScript to know its graph.

### Generated-file drift checks

Bazel: this PR wires `gazelle.check` (fails when BUILD files are stale) and
`//tools/format:format.check` (fails when sources are unformatted). Bazel
itself does not generate `pnpm-workspace.yaml` or the root `tsconfig.json`;
those remain inputs.

In-repo: `pnpm-workspace.yaml`, the workspace `tsconfig.json`, and
`pnpm-lock.yaml` are *outputs* of targets, drift-checked in lint mode via the
write/check split (`attrsForKind` maps lint to `{mode: "check"}`;
`packages/targets/src/GeneratedFile.ts`). `GithubCiGen` verifies that
`.github/workflows/ci.yml` still runs the declared gates.

Verdict: the in-repo system goes beyond Bazel here. Under Bazel, generated
workspace files would need `write_source_file`-style rules (available in
bazel_skylib and rules_js); this PR does not wire them because the files are
already generated by the in-repo system and duplicating the generator would
create two sources of truth. If Bazel were adopted, the natural mapping is a
`write_source_files` target for each generated file plus a diff test, which is
the same write/check split under different names.

### Secrets

Bazel: there is no secrets model. Credentials reach actions through
`--action_env` or headers passed on the command line, and they become part of
the action environment. Bazel's position is that actions are hermetic and
credentials belong outside the build; remote-cache authentication uses
`--remote_header`. This PR keeps the cache token out of the tree by writing
`.bazelrc.remote` in CI from a GitHub secret.

In-repo: `Smithers.Secret("SMITHERS_CACHE_TOKEN")` declares a name; key
material records the name and never the value; execution injects a random
placeholder and a loopback proxy substitutes the real value on outbound
requests (`packages/build-cli/src/SecretProxy.ts`).

Verdict: the in-repo system is ahead of Bazel on this axis, with one documented
gap: HTTPS CONNECT tunnels are not substituted
(`SecretProxy.ts:236-254`). Bazel's answer (keep secrets out of actions
entirely) is simpler and arguably safer; the in-repo proxy exists because its
actions are not sandboxed and tools need authenticated network access.

### `node_modules` as a dependency

Bazel: `npm_translate_lock` reads `pnpm-lock.yaml` and materializes the whole
npm graph as Bazel repositories. Each package is a content-addressed store
entry; each package's `npm_link_all_packages` creates `node_modules/<name>`
link targets. `node_modules` is not a target; it is a view over the action
graph. There is no install step. This is the single biggest reason Bazel is
tractable here, and it worked on the first day against this repository's
lockfile (lockfileVersion 9.0, pnpm 11.21.0).

In-repo: `Smithers.Install` is a target keyed on the declared toolchain and
the generated lockfile (`BUILD.ts:112-116`), running `pnpm fetch` into a
content-addressed store plus `pnpm install --offline` to link. It is
deliberately non-cacheable across runs because a linked tree cannot be
restored on another machine (`packages/build/src/Install.ts`).

Verdict: same shape, different owner. Bazel moves the fetch into repository
evaluation and the link into the action graph, so install disappears as a
build step. The in-repo Install target remains a real, sequential, uncached
step in every cold run. Bazel's model is better here, and section 6 recommends
copying it.

## 3. What Bazel gives that neither Nx nor Turborepo can

**Action-level caching.** Nx and Turborepo cache at task granularity: one
package's `build` script is one cache entry. Bazel caches every action: each
`tsc` invocation, each npm package extraction, each lint run. In this PR the
granularity shows in the numbers: a cold build of the slice (expunged output
base, fresh disk cache, warm repository cache) ran 559 sandboxed actions in
89 seconds, and the warm no-op rebuild is 1.5 seconds. Nx/Turborepo can match
the warm number; they cannot match the partial-invalidation behavior, where
editing one file re-runs exactly one `ts_project` action and nothing else.

**Sandboxing.** Every action in this PR ran under `sandbox-exec` with only its
declared inputs visible. This caught real bugs during the migration: tsc's
`package.json` lookup for module-type detection failed until
`js_tsconfig_package_deps` declared it, and the coverage gate failed until the
sources were declared as runfiles inputs. Those are exactly the class of bug
an unsandboxed task runner cannot see. Nx and Turborepo have no equivalent.

**Hermetic toolchains.** Node 22.19.0, pnpm 11.21.0, TypeScript 6.0.3, and
Rust 1.89.0 are all fetched by Bazel at pinned versions. The Bazel CI workflow
needs no `setup-node` or `pnpm/action-setup` step. The exception in this PR is
the Rust build itself, which uses host rustup through the cargo bridge (see
section 4); the toolchain pin still comes from `rust-toolchain.toml`.

**Remote execution and remote cache.** Bazel speaks the Remote Execution API:
`--remote_cache` (HTTP or gRPC) for caching, and full remote execution when
needed. Nx has Nx Cloud (proprietary, task-granular); Turborepo has a remote
cache HTTP API (task-granular). Neither has remote execution. This PR wires
`--config=remote` with Build without the Bytes
(`--remote_download_toplevel`), but no endpoint is configured by default.

Could Bazel point at the repository's own cache worker in
`packages/build/infra`? Not today. The worker serves a custom HTTP protocol:
`GET/PUT /ac/<digest>` with **JSON** action-cache entries validated against a
schema (`packages/build/infra/worker/protocol.ts`), `/cas/<digest>` for opaque
blobs, and `/cas/findMissing` for batch probes. Bazel's HTTP remote cache
protocol uses the same path layout but stores **serialized ActionResult
protobufs** at `/ac/`, with no JSON validation. The shape is close enough that
a compatibility mode (accept `application/octet-stream` AC bodies and store
them opaquely) would make the worker a Bazel remote cache. That is a small,
well-scoped change to the worker, and it would let both build systems share
one cache deployment.

**Cross-language graph.** One `bazel test //packages/... //crates/...` runs the
TypeScript suites and the Rust suites in one invocation with one cache. This
paid off concretely: the Rust crate's tests, clippy, and rustfmt are Bazel
test targets alongside Vitest, and the wasm artifact is a build target in the
same graph as the packages that consume it.

## 4. Where Bazel's model fights this repository

These are the friction points, in the order a migration would hit them.

**Gazelle generates one Bazel package per directory; this repo's tsconfigs are
package-rooted.** The JS plugin walks `src/` and `test/` and generates a
`ts_project` per directory. This repository's `tsconfig.json` files declare
`rootDir: "src"` and `outDir: "dist/esm"` at the package root, and
rules_ts's options validator rejects any target whose tsconfig paths do not
match the Bazel package layout. There is no per-package generation mode in the
plugin. The resolution in this PR has two layers. At the root, the directives
`# gazelle:js_files .bazel-no-root-sources` and
`# gazelle:js_test_files .bazel-no-root-test-sources` are inherited by every
directory, so Gazelle generates only package-level scaffolding
(`npm_link_all_packages`, `ts_config`, `pkg`) and never per-directory source
targets. In the three migrated packages, the ts_project and vitest targets are
then hand-written to match the tsconfigs exactly, and Gazelle preserves them.
This is the honest compromise, but it means the core build rules are not
generated from imports, and the `deps` lists are hand-maintained to mirror
`package.json`.

**Source-shipping packages.** The packages' `exports` maps point at
`./src/*.ts`, not at `dist/`. Consumers typecheck against sources. Under
Bazel this means the `npm_package` for each package must carry its sources,
and Gazelle's npm_package model (which computes `srcs` from the `files`
field) does not represent that; it stripped the source list on every run
until the rule was moved behind a macro Gazelle does not manage
(`tools/js/defs.bzl`). The mechanism works, but it is a workaround, and it
exists because the repository's packaging model is not the one the JS plugin
assumes.

**A package-level dependency cycle that pnpm tolerates and Babel cannot
analyze.** `@smthrs/kernel` declares a runtime dependency on
`@smthrs/platform-browser`, and `@smthrs/platform-browser` declares one back.
pnpm installs this without complaint; the repository's madge guard checks
file-level import cycles, not manifest-level ones. rules_js's generated
`npm_package_store` targets mirror the manifest edges, so the store graph
contains a cycle, and Bazel cannot analyze it:

```
ERROR: in npm_package_store rule //:.aspect_rules_js/node_modules/@smthrs+kernel@0.0.0:
cycle in dependency graph:
.-> //:.aspect_rules_js/node_modules/@smthrs+kernel@0.0.0
|   //:.aspect_rules_js/node_modules/@smthrs+platform-browser@0.0.0
`-- //:.aspect_rules_js/node_modules/@smthrs+kernel@0.0.0
```

The store targets live in the root package, so any wildcard that includes the
root package — `bazel build //...` — fails at analysis no matter what the rest
of the graph looks like. Per-package link targets are tagged `manual` by
rules_js, so the per-directory wildcards are clean. This is why the CI
contract in this PR is the explicit pattern set `//packages/... //apps/...
//examples/... //crates/... //tools/...` and not `//...`. A real adoption
requires breaking the cycle in the manifests, which is a product decision, not
a build decision. Bazel did us a favor by refusing, but the refusal is
absolute.

**Vitest coverage under a runfiles symlink forest.** `bazel test` runs from a
runfiles tree of symlinks. Vite realpaths imported modules by default, which
moved module URLs outside the working directory; the v8 coverage provider then
reported 0% against include globs that matched the symlinked paths, and the
100% threshold gate failed even though every test passed. The fix is three
lines in each package's `vitest.config.ts`
(`resolve.preserveSymlinks` when `TEST_SRCDIR` is set), behavior-neutral under
pnpm. But it had to be discovered, and it is the kind of issue every package
migration would re-hit until the config pattern is shared.

**ESLint 9 flat-config discovery vs the aspect's working directory.** The
rules_lint ESLint aspect runs from the Bazel bin root. ESLint 9 discovers flat
config from the working directory only, so per-package `eslint.config.js`
files are never found. The fix is the root aggregator `eslint.config.js`,
which imports each package's config and re-scopes its `files` globs. Two
subtleties cost time: flat-config arrays are order-sensitive (later global
entries re-enable rules earlier scoped entries disabled, so all global entries
must come first), and each package's plugin closure must be declared as
js_library deps so the plugins exist in the sandbox. Typed lint
(`projectService: true`) works under the aspect once the tsconfig is a
declared input, which the aspect does automatically for ts_project targets.

**dprint is not hermetic.** Each package's `dprint.json` references wasm
plugins by URL, and dprint downloads them on first use. There is no dprint
integration in rules_lint's formatter framework (its JS/TS formatter is
Prettier). This PR wires `//tools/format` and `//tools/format:format.check` as
`bazel run` targets over the npm-graph dprint CLI; they run in the workspace,
not in a sandbox. Making the check hermetic means vendoring the three wasm
plugins and pointing the configs at them, which is possible and small, but
touches every `dprint.json`.

**crate_universe cannot render this Rust graph.** The idiomatic rules_rust
path is `crate.from_cargo` over the committed `Cargo.lock`. It failed for a
structural reason: cargo-bazel's splicer requires every manifest in the graph
as a Bazel label, and the pinned jj fork is a git submodule. A submodule's
tree cannot carry committed files in the superproject, so no BUILD file can
exist inside `vendor/jj`, so `vendor/jj/Cargo.toml` (the workspace root that
jj-lib's `edition = { workspace = true }` inheritance needs) is not
label-addressable. The splicer copies the path-dependency manifest but not
the foreign workspace root, and cargo fails with
`workspace.package.edition was not defined`. The bridge in `tools/cargo/`
works around this: a repository rule symlinks the submodule tree into an
external repo (labels without touching the submodule), another runs
`cargo fetch --locked` at fetch time, and the pinned cargo runs offline in a
sandboxed action. The cost is cache granularity: the whole crate graph is one
action, not one action per crate. The fix that restores the idiomatic path is
upstream: teach cargo-bazel to copy foreign workspace roots, or publish the
jj fork with Bazel metadata.

**Hermeticity does not imply cross-host byte reproducibility.** The committed
`packages/jj/wasm/flows_jj.wasm` was built on x86_64-unknown-linux-gnu, and
its bytes are host-specific by rustc design: build scripts compile for the
host, the host triple enters `-C metadata`, and symbol hashing and codegen
order follow (documented and measured in
`crates/flows-jj/build-wasm.mjs`). Bazel's hermetic toolchain removes the
toolchain-version and checkout-path variables; it cannot remove the
host-triple variable, because the triple is semantically part of the output.
The `wasm_repro_test` diff_test is therefore gated to the canonical host. One
more caveat: the committed artifact is built by cargo, and this PR's bridge
runs the same cargo with the same remap tokens, so on the canonical host the
gate has a real chance of passing; it is wired in `bazel.yml` and its result
there is the honest signal. If it drifts, the cause will be flag-level
differences between `build-wasm.mjs`'s invocation and the bridge's, and the
fix is to align them, not to weaken the gate.

## 5. What it costs

**The Starlark surface.** MODULE.bazel, four tools/ packages, and the macro
files are a new language and a new mental model for every contributor. None of
it is TypeScript. The repository's own system keeps the entire rule catalog in
type-checked TypeScript with JSDoc; Bazel's equivalent documentation is prose
in external repos.

**BUILD-file maintenance even with Gazelle.** Gazelle maintains scaffolding
and dependency lists, but the interesting rules in this repository (ts_project
matching package-rooted tsconfigs, coverage-gated vitest, the npm_package
source list) are hand-maintained because the generator's model does not fit.
The drift gate (`gazelle.check`) is wired and verified — it fails when a
generated rule is removed and passes when Gazelle restores it — but it gates
only the generated surface.

**Cold-build time.** The cold build of the slice (89 seconds for 559 executed
actions, warm repository cache) is dominated by npm package extraction and the
Rust workspace compile. Without any cache, the first build on a fresh machine
adds the full npm and crates.io fetch. By comparison, `pnpm install` plus the
existing per-package builds distribute that cost differently. Bazel's win is
the warm path (1.5-second no-op, single-file invalidation), not the cold path.

**Onboarding.** `bazel test //packages/keys:test` is simple. Understanding why
the target set is not `//...` requires understanding the kernel cycle, the
link farm, and the analysis model. The failure messages are good (the cycle
error names both packages), but the volume of new concepts — loading vs
analysis vs execution, runfiles, sandboxing, transitions — is real.

**Flag parsing is a footgun.** The first version of this PR's `.bazelrc`
carried a valueless `build --disk_cache`, expecting Bazel's default cache
location. rc files are one token stream, so the flag consumed the next line's
`--spawn_strategy=sandboxed` as its path: the disk cache silently became a
directory named `--spawn_strategy=sandboxed` inside the workspace, and the
sandbox flag silently never applied (sandboxing kept working only because it
is the macOS default). No warning, in either direction. The same review found
`bazel --disk_cache=... build` in the CI workflow, which is a fatal "unknown
startup option", and `~` after `=`, which bash does not expand. None of this
is Starlark, but all of it is the Bazel surface a team has to learn.

## 6. What a migration would involve, and what our system should copy

### Migration sketch, in order

1. Break the `kernel` ↔ `platform-browser` manifest cycle. Everything else is
   blocked on this; without it no wildcard target pattern ever analyzes.
2. Migrate packages leaf-first using the slice as the template: add the
   Gazelle directives, the two ts_project targets, the vitest target, the
   eslint_config js_library, and the pkg rule. The per-package work is
   mechanical once the template exists; budget an hour per package for the
   first five and minutes per package after, with the long tail in packages
   that import assets, wasm, or fixtures (the `Purity.test.ts` pattern of
   reading `../src` at runtime works as long as the sources are declared).
3. Vendor the dprint wasm plugins and make `format.check` a sandboxed test.
4. Fix or bypass the crate_universe splicer limitation, then replace the
   cargo bridge with `crate.from_cargo` and per-crate targets.
5. Point `--config=remote` at a shared cache. If the JSON-vs-protobuf
   compatibility mode lands in the cache worker, the existing deployment
   works.
6. Only then consider deleting the pnpm scripts. This PR deliberately does
   not touch them.

### Design decisions our system should copy that it currently does not

This is the highest-value section of the comparison, because the in-repo
system is a Bazel-alike and these are the places the copy is incomplete.

1. **Cache every action by default; opt out by exception.** Bazel's default is
   cached; the in-repo default is `cache: false` (`Target.ts:495-501`), and
   the rules that would benefit most (TsBuild, the typechecks) are currently
   not admitted. The inversion is the single highest-leverage change
   available: it turns the remote cache from a niche into the fabric. The
   stated reason EsLint and Dprint are not cached ("until the external
   toolchain is complete key material") is a toolchain-identity problem, which
   item 2 solves.

2. **Fetch the toolchain; do not measure the host.** Bazel downloads Node,
   pnpm, TypeScript, and Rust at pinned versions and never consults `PATH`.
   The in-repo system declares a toolchain and *verifies the host satisfies
   it* (`Runtime.Service.verify`), which means two machines with different
   patch versions of Node produce different action outputs for the same key,
   and the cache cannot admit tool-running rules without lying. The
   declaration model (`Runtime.Node({version})` as a value threaded through
   targets) is already right; what is missing is a `Toolchain` service that
   downloads the declared interpreter into `.flows/store` and execs that
   instead of the host's. Once the tool bytes are key material, the
   uncached-by-default rules become cacheable, which compounds with item 1.

3. **Sandbox execution, or at least input-restricted execution.** Bazel runs
   every action with only declared inputs visible, and this PR's migration
   found two real undeclared-dependency bugs in one afternoon because of it
   (the tsc package.json lookup, the coverage sources). The in-repo executor
   spawns tools directly with a narrow env allowlist
   (`packages/build-cli/src/Exec.ts`) but full filesystem visibility, so
   undeclared reads succeed silently and poison cache keys that cannot see
   them. On macOS the mechanism exists (`sandbox-exec`); on Linux, namespaces.
   Even a weaker form — bind the workspace read-only and project only declared
   inputs into a scratch root — would catch the same bug class.

4. **Make `node_modules` a view over the graph, not an install step.** The
   in-repo `Install` target is deliberately uncacheable and sequential, and
   every cold run pays for it. rules_js's model — a content-addressed store
   plus per-package link targets materialized as action inputs — eliminates
   the step entirely, and this PR demonstrates it works against this exact
   lockfile. The in-repo store (`.flows/store`) already exists; the missing
   piece is per-action link materialization instead of a workspace-wide
   `node_modules`. This also removes the `verifyDepsBeforeRun` class of
   hazard, because there is no ambient install for a gate run to mutate.

5. **Refuse dependency cycles at the manifest level.** Bazel's analysis error
   on kernel ↔ platform-browser is the system working as designed. The
   in-repo `circular` gate (madge) checks file-level imports and lets the
   manifest cycle through. A package-level cycle check is cheap to add to the
   existing guard and would have surfaced this before Bazel did.

6. **Keep the things our system already does better.** The comparison is not
   one-directional. `PackageDefaults` synthesis (no generated files, nothing
   to drift), attribute-walked dependency inference, TypeScript-typed rule
   definitions, generated workspace files as first-class target outputs with
   the write/check split, and the secrets proxy are all ahead of the Bazel
   equivalents. A migration that loses these would be a downgrade in
   day-to-day ergonomics even where it is an upgrade in hermeticity. The
   in-repo system's correct long-term shape is Bazel's execution and caching
   semantics under its own declaration model, not Bazel's declaration model.

## Appendix: verified commands and measured numbers

All from this worktree, Bazel 8.7.0, darwin-arm64.

```
# Cold build: expunged output base, fresh disk cache, warm repository cache.
$ bazelisk build --disk_cache=/tmp/fresh-disk-cache //packages/... //crates/... //tools/...
INFO: Elapsed time: 89.357s, Critical Path: 68.69s
INFO: 1564 processes: 1005 internal, 559 darwin-sandbox.

# Warm no-op build.
$ bazelisk build //packages/... //crates/... //tools/...
INFO: 1 process: 11 action cache hit, 1 internal.
1.50 real

# Full test set.
$ bazelisk test //packages/... //crates/... //tools/...
//crates/flows-jj:cargo_test                                   PASSED in 38.9s
//crates/flows-jj:clippy_test                                  PASSED in 28.3s
//crates/flows-jj:rustfmt_test                                 PASSED in 0.3s
//packages/canonical:test                                      PASSED in 5.5s
//packages/canonical:ts_tests_typecheck_test                   PASSED in 0.5s
//packages/crypto:test                                         PASSED in 5.7s
//packages/crypto:ts_tests_typecheck_test                      PASSED in 0.7s
//packages/keys:test                                           PASSED in 5.7s
//packages/keys:ts_tests_typecheck_test                        PASSED in 0.3s
Executed 9 out of 9 tests: 9 tests pass.

# Lint aspect (ESLint, sandboxed, cached).
$ bazelisk build --config=lint //packages/... 
INFO: Build completed successfully.   # exit codes 0 for all three packages

# Format gate.
$ bazelisk run //tools/format:format.check    # exit 0; exit 20 with a misformatted probe file

# Gazelle drift gate.
$ bazelisk run //:gazelle.check               # exit 0; exit 1 with a generated rule removed

# Dependency graph.
$ bazelisk query 'deps(//packages/keys:ts)'   # 2,489 targets under //packages/...

# The wasm artifact, built sandboxed on this host.
$ shasum -a256 bazel-bin/crates/flows-jj/flows_jj.wasm packages/jj/wasm/flows_jj.wasm
4792ea38…  bazel-bin/crates/flows-jj/flows_jj.wasm   # this host (darwin-arm64)
3a14db0e…  packages/jj/wasm/flows_jj.wasm           # committed (linux-x86_64)
```

The two wasm hashes differ, as they must: the committed artifact's bytes
belong to the canonical host. The gate that compares them runs on that host in
`bazel.yml`.
