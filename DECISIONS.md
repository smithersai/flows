# Build-system decisions D1–D15

The in-repo build system (`BUILD.ts` + `@smthrs/targets` + `@smthrs/build` +
`@smthrs/build-cli`) is a Bazel-alike. These fifteen decisions close the gaps
found by comparing it against real Nx, Turborepo, and Bazel setups of this same
repository (PRs #225, #226, #227). Bazel is the model; where a decision says
"like Bazel", read the Bazel behaviour as the specification.

Focus is TypeScript/JavaScript. Ambition is warranted: we are not trying to be
polyglot, so we can be more granular than a general-purpose tool.

**Revision, 2026-08-18.** Every correction in `CORRECTIONS.md` is applied to the
decision text below. The Wave-0 mapping pass verified the original premises by
running the code and found sixteen of them wrong. Where a premise was wrong and
the goal was sound, the premise is rewritten and the goal kept. Where a decision
cannot be done as written, the honest alternative is stated inside the decision.
Line numbers cite the tree at the time of that pass. `CORRECTIONS.md` holds the
evidence for each change; `BUILDSYS-PLAN.json` holds the wave and lane
assignment this document's sequencing refers to.

---

## D1 — Split the root config into `WORKSPACE.ts` + `BUILD.ts`

Mirrors `MODULE.bazel` / `BUILD.bazel`. One root `WORKSPACE.ts` declares what
exists; `BUILD.ts` files declare targets.

Moves to `WORKSPACE.ts`: `runtime`, `packageManager`, `Secret` declarations,
`PnpmWorkspace`, `Lockfile`, `Install`.
Stays in root `BUILD.ts`: `Tsconfig`, `GithubCiGen`, `PackageDefaults`, `file()`
declarations.

The toolchain registers once (`Smithers.registerToolchains(...)`), Bazel's
`register_toolchains` move, so no target attr threads `packageManager` any more
and no package `BUILD.ts` imports `../../BUILD.ts`. `rootJSDocConfig` becomes the
root-absolute label `Smithers.file("//eslint.jsdoc.js")`, which already works.

**Discovery has four dependencies on the `BUILD.ts` name, not two.**
`packages/build-cli/src/Workspace.ts` calls `buildEntry(canonical, "BUILD.ts")`
at `:477` and `:514` for config resolution. It also filters the workspace
listing to `BUILD.ts` and `*/BUILD.ts` in `this.buildFiles` (`:794`). The fourth
is `Input.isPackage` (`Input.ts:401-415`), which compares the basename
`BUILD.ts` exactly to decide the glob package boundary. Discovery must learn
`WORKSPACE.ts` at the first three. It must **not** learn it at the fourth:
adding `WORKSPACE.ts` to the package-boundary check would change the scope of
every glob in the repository.

**Removing the attr without folding the toolchain into `ambient` silently drops
it from every cache key.** Target attrs are key material (`Planner.ts:960`), and
the whole `PackageManager` declaration rides there today. The same change that
removes the attr must make the toolchain registration the source for three
consumers:

- `ambient` key material (`Planner.ts:897-906`), so a pnpm version bump still
  invalidates. The intended net effect on cache keys is **unchanged**: the same
  toolchain identity, carried in a different field.
- `layers()` (`Workspace.ts:812-833`), which derives the Install and Lockfile
  layer identity from `attrs.packageManager.name@version` and returns `[]`
  without it.
- `declaredToolchain` (`engine.ts:234-264`), which falls back to pnpm `>=0.0.0`
  when the attr is absent, turning every declared version requirement into "any
  version" with no error.

`smthrs install` already ignores the declared toolchain (`Cli.ts:230-241` passes
none). That is a wire to build, not a behaviour to preserve.

Moving `Install`, `Lockfile`, and `PnpmWorkspace` out of root `BUILD.ts` deletes
the labels `//:nodeModules`, `//:lockfile`, and `//:workspace` unless the
`WORKSPACE.ts` exports are registered as targets. `nodeModules` is the second
entry in the hardcoded default-target candidate list
(`Workspace.ts:992-999`), so a bare `//` stops resolving, which
`packages/build/docs` teaches.

D1 makes package `BUILD.ts` files toolchain-free. **It deletes none of them.**
Six package `BUILD.ts` files exist for four distinct reasons and only one is the
toolchain import; see D14.

## D2 — Projected execution: only declared deps are visible

**This is a bug against spec, not a new feature.** `Exec.ts` narrows the
environment but leaves full filesystem visibility, so an undeclared read
succeeds silently and poisons a cache key that cannot see it. Bazel runs every
action with only its declared inputs projected into a scratch root.

**Mechanism: copy-in projection.** Seed a scratch root with exactly the declared
inputs, run the child there, copy declared outputs back, all under the
confinement discipline `SafeFs` already implements. Do not specify
`sandbox-exec` or Linux namespaces. Neither appears anywhere in this repository:
a repo-wide grep for `sandbox-exec`, `seatbelt`, `bubblewrap`, `chroot`,
`unshare`, `landlock`, `pledge`, `firejail`, and `CLONE_NEW` returns zero hits
outside this document, and macOS `sandbox-exec` is a deprecated Apple interface.
The spec vault's own tier plan
(`/Users/williamcory/flows/docs/specs/Concepts/Effect Taxonomy.md:60-86`) names
bubblewrap and Microsandbox for Linux and virtual-fs seeding for the browser.
The nearest in-repo prior art is `EngineStore.WorkspaceSandbox`.

**This is a determinism boundary, not a security boundary.** Say so in the code
and the docs. `WorkspaceSandbox`'s own module doc states the same property and
adds that a spawned native process falls outside it, which is exactly the build
system's case. The goal is to catch the undeclared-read bug class, and the
weaker first form the original decision offered as a fallback (project declared
inputs, deny the rest) is now the primary specification.

**Projection is opt-in, and D12 is a hard prerequisite, not a peer.** Declared
inputs are auto-derived by walking attrs (`Target.ts:509-555`), and
`StandardPackage` declares only sources, tests, and four config files.
`Typecheck`'s attrs are `srcs`, `deps`, and `tsconfig`, while `tsc` additionally
reads the extended base tsconfig, `node_modules/typescript`, and every
dependency's declarations. Every catalog rule invokes its tool through
`PackageManager.exec` (`pnpm exec tsc`), and no target declares `node_modules`,
which `Input.ts` refuses to expand into anyway. Strict projection by default
turns all 272 targets under `//packages/...` red on day one and reads as a
repo-wide regression rather than as the bug being caught.

Land it as follows:

1. Ship the projection primitive with the per-target `sandbox` field defaulting
   to `false` (Wave 1 capability, Wave 2 execution).
2. Prove it on one narrow target whose inputs are fully declared, such as the
   Rust lane's `ToolBuild` genrule from D8.
3. Flip rules to projected one at a time, as D12 completes each rule's input
   closure.

Projection must keep loopback (127.0.0.1) reachable. The secret-substituting
proxy from D9 binds loopback, so a projection that severs it breaks every
declared secret silently.

## D3 — The sandbox is configured from `WORKSPACE.ts`

Sandbox policy is a declaration, not a CLI-only flag. The declaration carries
the default mode, which stays `false` until D12 completes a rule's input closure
(D2), and the per-run override is D15's loud flag. The mode itself is key
material; see D15.

## D4 — Rules take an inline constructor **or** a config-file path

`Vitest({ tests, sources, config, ... })` today. Also accept
`Vitest("vitest.config.ts")`, a path alone, for the common case. Apply the
same duality across the catalog wherever a tool already has a config file
format.

**The path form must still produce a complete declared-input set.** A path names
only the `config` attr. `Vitest`'s attrs are `tests`, `sources`, `deps`,
`config`, `environment`, `passWithNoTests`, and `cwd`, so a path-form target
with empty or omitted `tests` and `sources` is a target whose declared inputs
are wrong. That is harmless today because the rule is uncached and unprojected,
and actively dangerous after D5's flip and D2's projection. The path form
therefore derives its globs from the same conventions `StandardPackage` uses and
adds the named config file to them. It never omits them.

The build system does not parse `vitest.config.ts`, `eslint.config.js`, or any
other tool config, so the globs come from convention, not from the file. Say
that in the rule's JSDoc so no reader assumes the `include` patterns are honoured.

Sequence D4 after D1: a path form cannot name a package manager while the attr
still exists.

## D5 — `cache: true` by default, opt out by exception

`Target.ts:495-501` defaults `cache` to false. Bazel and Turborepo both default
to cached. Flip the default.

**Nine rules fall through to the default and are the rules this flip affects**,
measured across `packages/targets/src`: `BiomeCheck:106`, `DepsLint:104`,
`DtsBuild:88`, `PackageLint:80`, `TsBuild:81`, `Typecheck:78`,
`TypedocDocs:62`, `Vitest:57`, `VitestCoverage:89`.

**Sixteen rules already declare `cache: false`** and keep it: `Changesets:102`,
`Clean:80`, `Dev:53`, `Dprint:61`, `EsLint:72`, `Install:110`, `JsrPublish:69`,
`LlmLint:1344`, `Lockfile:96`, `NewPackage:453`, `NpmPublish:74`,
`PackageJson:1136` (`PackageJsonWrite`), `PnpmWorkspaceFile:140`,
`SortPackageJson:63`, `Tsconfig:131`, `VitestWatch:63`. Three set `cache: true`
(`Filegroup:336`, `DocsParity:324`, `PackageJsonCheck:1111`) and two compute it
(`GithubCiGen:897`, `ToolBuild:1074`). Treat any list of opt-outs in this
document as illustrative. **Never delete an explicit `cache: false` because a
decision omits that rule.** The wasm reproducibility gate keeps its opt-out for
the stated reason: a cache hit would skip the rebuild that is the gate.

**Apply the flip at both `Target.ts:687` and `Target.ts:715`.** Flipping only
`:715` leaves `implementationDigest` recording `["constant", false]` for a rule
that is now cacheable, so the digest stops identifying the cache decision it
claims to identify.

**Four prerequisites, not one.** The original decision claimed D2 alone licenses
the flip because D2 falsifies the `Target.ts:496-499` comment. That comment
gives two independent reasons and D2 addresses only the first. The second is
recorded in `packages/build/docs/workspace/caching.md:112-114` and the per-rule
pages (`ts-build.md:87`, `vitest.md:63`, `typecheck.md:71`): these rules stay
uncached because the executable toolchain is not complete key material.

1. **D2's projection**, so an undeclared read cannot poison a key.
2. **Toolchain identity in key material.** Today the only toolchain material is
   `ambient.lockfile`, one sha256 of `pnpm-lock.yaml` (`Planner.ts:901-904`).
   Nothing digests the installed `node_modules` tree or the tool binary, so an
   uninstalled lockfile, a partial install, and a locally linked tool all key
   identically. D1's ambient fold satisfies this for the declared toolchain
   (Wave 1). The installed binary stays open.
3. **Declared-input completeness for the nine rules**, above all `Vitest`, which
   declares `test/**/*.test.ts` plus `src/**/*.ts` and leaves 97 files under
   `packages/*/test/` (52 `.ts` harnesses and 45 fixtures) declared by no
   target. Caching before this produces a stale green test run on the first
   harness edit (Wave 4).
4. **The subpackage-pruning guard from D13** (Wave 3). Adding a nested
   `BUILD.ts` silently prunes the parent's declared inputs while the parent's
   `tsc -b` still compiles the subtree, verified empirically. Under a cached
   default that replays a stale parent build.

Gate the flip on the three of these the plan schedules, not on D2 alone.

**Six rules gain wall clock, not nine.** `Typecheck`, `Vitest`,
`VitestCoverage`, `BiomeCheck`, `DepsLint`, and `PackageLint` declare no
outputs, so a hit is a full skip. `TsBuild`, `DtsBuild`, and `TypedocDocs` become
cacheable but stay inert on a fresh checkout: the cache stores only a JSON
success envelope (`Cache.ts:32-51`), there is no artifact store and no output
restoration, and a hit for a target with declared outputs requires those outputs
to already be on disk and still match the recorded digest
(`Executor.ts:943-964`, where a failing output check silently falls through to a
normal run). File the artifact store as a separate decision and do not count its
benefit here.

## D6 — Bazel-style `visibility`, at package **and** folder level

Declared on the target being depended on: who is allowed to depend on me.
Enforced statically at plan time by resolving each source file's imports to a
target and comparing against that target's visibility.

Shorthands:

| ours | bazel | means |
| --- | --- | --- |
| `Visibility.private` (default) | `//visibility:private` | this directory only |
| `Visibility.package` | — | anybody inside this package |
| `Visibility.subpackages` | `:__subpackages__` | this directory and below |
| `Visibility.public` | `//visibility:public` | anywhere in the repo |
| `Visibility.of("//packages/flow", ...)` | label list | those only |
| `Visibility.group(engineTier)` | `package_group` | a named set |

**The import graph does not exist and must be built.** There is no
`scripts/circular.mjs`. `ls scripts/` returns `browser-check.mjs`,
`check-test-pins.mjs`, `flows-backup.mjs`, `pack-release.mjs`,
`release-rehearsal.mjs`, `set-release-version.mjs`, and `smoke-release.mjs` plus
their tests. What exists is 45 identical per-package copies at
`packages/*/scripts/circular.mjs`, each about 18 lines running madge over one
package's `src` with `skipTypeImports: true`, driven by
`pnpm --recursive --if-present run circular` (`package.json:11`). There is no
repo-wide graph, no cross-package edge, no type-only coverage, and no mapping
from an import specifier to a target label.

Budget a new repo-wide import walker in `packages/build-cli` as new work. Run it
at plan time and enforce inside Planner's visit, where dependency edges already
resolve to labels. The per-package madge guards skip type-only imports, so
decide the type-only policy explicitly rather than inheriting theirs.

**`Visibility.group` needs a per-directory manifest query that does not exist.**
Nothing in the build system reads `smthrs.group`. It appears in all 45 package
manifests, and the only readers in the tree are `scripts/pack-release.mjs:39-41`,
`scripts/check-test-pins.mjs:112`, and `packages/flows/test/index.test.ts`.
Neither `packages/targets/src`, `packages/build/src`, nor
`packages/build-cli/src` contains a manifest reader at all. There is also no
visibility system, no tier concept, and no import restriction anywhere in the
target model; the only occurrences of the word are a `Filegroup` doc block
stating its absence (`Filegroup.ts:23-32`) and two doc pages repeating it.

Build the manifest query once, as shared infrastructure. D10 needs the identical
mechanism to derive the engine release set from the graph, and D13's
`PackageDefaults` needs it to pass name and version to the macro.

```ts
export const engineTier = Smithers.Visibility.group({ where: (pkg) => pkg.smthrs.group === "engine" })
```

**Visibility is not key material.** Follow the `Metadata.verbGate` precedent
(`Target.ts:503-506`, `:716-717`, enforced at `Planner.ts:877-884`): a
per-target allowlist deliberately kept out of the key, so changing who may
depend on a target does not invalidate that target's cache.

This is unenforceable in Node today: `exports` blocks a subpath from outside a
package, but nothing controls one folder importing another within a package.

## D7 — The hand-written `ci.yml` gates become root targets

Seven script gates in the `test` job are unmodelled (`ci.yml:52`, `:57`, `:59`,
`:65`, `:71`, `:75`, `:80`):

```
pnpm run browser
pnpm run circular                    (no Circular rule exists)
node --test scripts/pack-release.test.mjs
node --test scripts/release-rehearsal.test.mjs
node --test scripts/set-release-version.test.mjs
node --test scripts/flows-backup.test.mjs
node --test scripts/check-test-pins.test.mjs
```

**Those seven are a subset.** `ci.yml` has 69 steps across 8 jobs; 8 map to graph
targets and 61 do not. The full unmodelled surface is roughly 20 distinct `run:`
commands plus 3 gate-carrying `uses:`. Beyond the seven: actionlint (`:19`), the
install (`:28`), the jj init (`:41`), the clean rebuild (`:87`),
`pack-release.mjs` (`:93`), `smoke-release.mjs` (`:94`), four rust verbs
(`:112-121`), three wasm-repro steps (`:153-171`), and the bun suite loop
(`:214-217`). `pnpm run browser` appears twice (`:57` and the whole browser job
at `:237`), so modelling it retires two steps and one job.

Model the seven as `ToolBuild` declarations so `//:browser`, `//:circular`, and
the rest are addressable like any other target.

**Landing D7 alone changes nothing operationally.** `//:ci` is never executed by
any CI step. `GithubCiGen`'s kinds are `[build, lint]`; `ci.yml:50` runs the
`docs` verb and `ci.yml:297` runs `ci "//packages/..."`, and that pattern
returns 272 labels with zero `//:` among them against 280 total. **Do three
things in one change**: model the seven, add a CI step that actually plans
`//:ci`, and strengthen the contract with a full gate list plus a `requiredJobs`
list.

Rewrite `scripts/pack-release.test.mjs` in the same change. Its cross-workflow
parity extractor (`:152-157`) recognises only `pnpm run <script>`, `pnpm test`,
and `node [--test ]scripts/*.mjs`, so converting a gate to a `smthrs`
invocation makes the test pass vacuously and silently stop protecting
`release.yml`.

Contract mode is not caused by D7 alone. `GithubCiGen`'s own JSDoc (`:837-877`)
gives the larger reason: a hand-written pipeline carries comments,
`continue-on-error` advisories, matrix jobs, and platform lanes that no
declaration reproduces. See D11.

## D8 — Rust is a thin `ToolBuild` declaration, not a subsystem

`ToolBuild`'s attrs are already a genrule (`inputs`, `outputs`, `deps`, `env`,
`cache`, `cwd`). Declare cargo verbs in `crates/flows-jj/BUILD.ts` with
self-declared inputs and outputs. Do **not** build a `Cargo` rule and do **not**
reimplement per-crate `rustc` driving. We have exactly one first-party crate
(1,139 lines). Revisit only if that count grows.

The wasm target declares `cache: false`: the rebuild is the gate.

Because this lane's inputs and outputs are fully declared, it is the target D2
proves projection on first.

## D9 — Closed environment allowlist

**The allowlist already exists; the gap is narrower than "no equivalent".**
`Exec` gives a child a closed 19-name world: the frozen 14-name
`inheritedEnvironmentNames` (`Exec.ts:343-358`) plus five forced locale and
colour values, merged with the payload env, then a denylist pass, then secrets.
Turborepo's `envMode: "strict"` differs in one respect that matters: **those 14
inherited values never enter key material.** `Planner.ts:897-906` carries node
version, platform, arch, the lockfile digest, and an implementation fingerprint,
and no environment value appears anywhere in a key. A target that reads
`process.env.CI` therefore has an unkeyed input, the same bug class as D2.

Make the inherited values declarable and make declared values key material.

**Three other spawn paths are in scope.** An allowlist implemented only in
`Exec.ts` claims a closed environment the repository does not have:

- `LlmLint.spawnEnvironment` copies all of `process.env` and deletes a denylist
  (`LlmLint.ts:443-467`).
- The package manager builds its own 15-name allowlist plus every `${NAME}`
  referenced by the project `.npmrc` (`build/src/PackageManager.ts:749-798`).
- `Workspace.runGit` spreads `process.env` (`Workspace.ts:121-137`).

**The secret model is dormant, so "must not regress" is currently satisfiable by
changing nothing.** `Secret("NAME")` plus placeholder plus substituting proxy is
real and well tested, and it has zero production callers. No target attrs schema
accepts a `Secret.Declaration` except `GithubCiGen`, which only names the
variables in the generated workflow (`:361-363`), and the remote-cache config.
The root `BUILD.ts` declares `cacheToken` and `cacheUrl` and passes them only to
`GithubCiGen`. `Exec.Payload.secrets` is therefore always empty in production and
`withSecretEnvironment` always takes its zero-secret fast path (`Exec.ts:789`).

If the intent is that the model becomes usable, that is unbuilt work: a
target-level `secrets` attr and at least one production caller. Scope it
explicitly or state that the model stays dormant.

Correct the false module doc at `SecretProxy.ts:10-13`. It claims the in-process
substitution seam is applied by every outbound request the build makes, "which
today means the remote-cache client". The client sets
`authorization: Bearer ${this.token}` from a raw string read in `Cli.prepare`
(`Cache.ts:1173-1174`, `Cli.ts:103-106`) and never touches a vault.

The substituting proxy binds loopback, so D2's projection must keep loopback
reachable or every declared secret breaks silently.

## D10 — Publishing: Bazel-shaped targets, native versioning, DRY manifests

`NpmPublish` exists and no `BUILD.ts` calls it; publishing happens in
`scripts/pack-release.mjs` outside the graph.

**Wiring `NpmPublish` into the package macro has three blockers. Fix all three
first.**

1. `NpmPublish` runs through `ExecIrreversible`, and the executor's layer stack
   does not provide `ExecIrreversibleLive` (absent from `Executor.ts:239-254`),
   so the action resolves to nothing: a target that plans and then fails at
   interpretation. Gate `ExecIrreversibleLive` into the executor behind the run
   verb, with D15's loud-flag treatment.
2. It publishes a **directory** through `pnpm publish` in
   `dirname(packageJson.path)`, while this repository publishes tarballs built
   from a staging copy whose manifest was rewritten. With source-first
   manifests, running it as written would publish TypeScript source as the
   package entry. Give it a tarball or staged-directory input plus the
   `pnpm view` idempotence probe `release.yml` already relies on.
3. The macro has no manifest. `StandardPackage.Options` carries no name,
   version, or group, and `PackageDefaults.expand` hands the macro one static
   attrs record shared by every match. Teach `expand` to pass the matched
   directory's name, version, and `smthrs.group`, using D6's shared manifest
   query. Verify `verbGate` holds transitively so `ci` graphs stay clean.

Then `//packages/journal:publish` exists.

**Versioning stays native; changesets is a from-scratch adoption, not a wiring
job.** There is no `.changeset/` directory, no `@changesets/*` in any
`package.json` or in `pnpm-lock.yaml`, no config, and no `CHANGELOG.md` anywhere.
`packages/targets/src/Changesets.ts` models only `status` and `version`, shells
out to `pnpm exec changeset version`, and has zero call sites. Either adopt
`@changesets/cli` as its own dependency decision with its own config, or build
on `scripts/set-release-version.mjs:45-76`, which already implements exactly the
Nx `updateDependents: auto` behaviour across all four dependency fields, with
protocol ranges correctly excluded, and is already CI-gated. Do not describe the
existing mechanism as missing. Internal range retargeting on bump stays a
requirement either way: bumping `@smthrs/journal` must retarget every
`"@smthrs/journal": "0.1.0"` range in the other engine manifests, or the
published set depends on a version nobody published.

**The release graph is not acyclic, so a planner that refuses cycles cannot
order this workspace.** `scripts/pack-release.test.mjs:125-140` pins
`kernel -> platform-browser` as a known, accepted cycle, and
`pack-release.mjs:93-111` implements a deliberate cycle-entry rule with an
alphabetical tiebreak to order through it. Either reproduce that behaviour
exactly in whatever graph ordering replaces the directory walk and keep the
pinning test, or keep `pack-release.mjs` as the ordering implementation behind a
graph-declared target. Preserve `assertBuilt`, the `publicationManifest` export
rewrite, and the `--list` / `--names` CLI the release runbook drives.

The engine set derives from `smthrs.group` through D6's shared manifest query.

**Manifest correctness for published packages must be DRY and generated.** Take
opinions from `wevm/zile` (https://github.com/wevm/zile): zero-config,
`package.json`-driven, ESM-only, auto-generated distributable manifest. Its
`[!start-pkg]` marker convention splits dev fields from published fields in one
file; see `zile/src/Package.ts`.

## D11 — Generated files both generate **and** check

Every generated file should be regenerable and drift-gated, the way
`bazel run //:gazelle` pairs with `//:gazelle.check`.

**There are four mode vocabularies and one dead shared one.**
`GeneratedFile.Mode` (`:34-44`, constructor default `"write"`) is dead code: no
target imports it. `Tsconfig` (`:57-60`) and `PnpmWorkspaceFile` (`:61-64`) each
redeclare their own `Schema.Literals(["write","check"])` with the **opposite**
default, `"check"`. `PackageJson` uses a three-valued `SyncMode` (`:570`) and
`GithubCiGen` a three-valued `OutputMode` (`:47-49`).

Unifying them requires reconciling the opposite defaults. **Choose `"check"`**:
it is what the two live implementations do. `Tsconfig` and `PnpmWorkspaceFile`
are also one target with a mode attr, not a gazelle-style check/write pair. Only
`PackageJson` ships the pair, hand-rolled in `PackageJson.targets`
(`:1466-1515`); lift that shape into `generateFile`. Neither `Mode` nor
`generateFile` is exported from the `Smithers` namespace, so export the shared
vocabulary from `Smithers.ts` before any `BUILD.ts` can use it.

**`GithubCiGen` cannot move to write mode when D7 lands.** Write mode cannot
reproduce the checked-in `ci.yml`. The `Job` schema models only `id`, `name`,
`runsOn`, `timeoutMinutes`, `continueOnError`, and `steps` (`:133-156`); the
`Step` schema only `name`, `uses`, `run`, `with`, `env` (`:92-98`). There is no
`needs`, `permissions`, job-level `env`, `strategy` or matrix, `environment`,
`outputs`, `defaults`, step `if`, step `id`, step `shell`, or
`working-directory`, and comments are lost entirely. `ci.yml` carries 60+
load-bearing comment lines and 8 jobs (rust, wasm-repro, bun, browser,
node-macos, node-windows, smthrs-shadow), 4 `continue-on-error` uses, a Docker
actionlint action, a clean-dist rebuild loop, and a pack-plus-smoke release step.
`release.yml` is further out of reach: `Attrs` models only `push.branches`,
`pull_request`, and bare `workflow_dispatch`, with no `push.tags`, no
`workflow_dispatch.inputs`, no top-level `permissions`, and no job
`environment`.

**The honest interim is to keep contract mode and make the contract strong**:
every gate declared, a `requiredJobs` list, and the CI step from D7 that
actually runs it. Generating a weaker `ci.yml` than the one checked in would be
a net loss of gate coverage. Treat the render-model expansion and the
comment-preservation question as a separate, larger decision.

## D12 — Every npm package is a target

Bazel's `:node_modules/effect` shape. `node_modules` is currently one opaque
tree keyed on the lockfile, so projection can only project all of it or none.

```ts
// WORKSPACE.ts
export const npm = Smithers.NpmLock({ lockfile })
```
```ts
// packages/flow/BUILD.ts
export const lib = Smithers.TsBuild({ srcs: [sources], deps: [plan, npm("effect")], cwd })
```

`NpmLock` takes the lockfile and reads the registry from it. It does not take
`packageManager`: D1 removes that attr from every target declaration.

**D12 is a hard prerequisite of D2, not a peer.** Every catalog rule invokes its
tool through `pnpm exec`, and no target declares `node_modules`. Projection
without per-package addressing turns the whole repository red.

**Four mechanisms block the obvious implementation, and three are deliberate
safety properties with written rationales. Per-package addressing must not relax
any of them.**

- Declared-input expansion refuses `node_modules` outright (`Input.ts:544` skips
  the directory name, `:625` short-circuits any pattern rooted in it).
- Declared-output capture refuses symbolic links at the declared root and
  anywhere inside the tree (`ToolBuild.ts:657-662`, `:761-763`), and pnpm's
  `node_modules` is a symlink farm.
- Nothing may declare an output under the reserved roots `{.flows, .git}`
  (`Target.ts:99`), and the store lives at `.flows/store`.
- The package manager exposes only workspace-wide `fetch` and `link` with no
  per-package verb, and `npm`, `bun`, and `yarn` are `makeNoop` refusals that
  fail every operation.

**The honest design is a lockfile-derived handle, not a file set.** Make
`npm(name)` content-addressed on the lockfile entry and its transitive closure.
Nothing parses `pnpm-lock.yaml` today; it is only digested, and
`GithubWorkflow.ts:18-26` records that a YAML dependency was rejected on
dependency-policy grounds, so write a targeted lockfile scanner following that
precedent. Only pnpm can be made granular first. Say so.

## D13 — Any folder with a `BUILD.ts` is a buildable, cacheable unit

Generated manifest per unit so Node resolution works. Editing one file in
`src/internal/` recompiles that folder, not the package.

```ts
// packages/engine/src/internal/BUILD.ts
export const lib = Smithers.TsBuild({
  srcs: [Smithers.glob("*.ts")],
  deps: [npm("effect")],
  visibility: Smithers.Visibility.package
})
```

**Half of this already ships.** Verified by running the real CLI against a
scratch workspace: `//pkg/src/internal:lib` resolves today, `//...` enumerates
it, and label resolution is depth-agnostic (`Label.ts:25-62`,
`Workspace.ts:752-755`, `:1117-1128`). Bazel's subpackage rule for globs is fully
implemented (`Input.ts:401-415`, `:474-491`, `:539`, `:645`). A nested `BUILD.ts`
is naturally additive, because `eligible` checks only `<directory>/BUILD.ts`
(`Workspace.ts:1014-1019`).

**Three pieces are genuinely missing.** Scope D13 to these:

1. Synthesis for marker-less directories.
2. A unit-shaped manifest. The current `PackageJson` cannot express one: it
   demands a publishable npm name, a literal semver, and a build target with
   `outDir` and `format`.
3. Cross-unit dependency bookkeeping.

**The shipped half hides a live correctness bug, and it is a hard requirement of
this decision to fix it.** Adding `pkg/src/internal/BUILD.ts` silently removed
`pkg/src/internal/b.ts` from `//pkg:lib`'s declared inputs, verified by diffing
`build //pkg:lib --plan --json`, while the parent's `tsc -b` still compiles that
subtree. A target whose declared glob is pruned by a subpackage boundary must
depend on a target in that subpackage, or the plan fails. Otherwise adding a
folder unit produces a silently stale parent build, and D5's flip turns that
into a stale green. Land this guard before D5's flip, not after.

**Folder-level `BUILD.ts` stays optional.** A folder without one inherits the
package's targets; you add one only to diverge or to restrict visibility.

**State the zero-boilerplate property honestly.** The repository has 8
`BUILD.ts` files (root, `lint`, and six under `packages/`), 39 of 45 packages
have none, and all 45 still hand-write six per-package config files, 270 files
in total. The property is **zero build files for 87% of packages, scoped to
build-tool config**, against turbo 50, bazel 60, and nx 46. It is still our
single strongest property against all three competitors, and D13 must not cost
it.

## D14 — `BUILD.ts` dep lists self-update in dev, are checked in CI

Not fully generated: hand-written, but the dependency/import section is
maintained automatically from real imports during normal runs, and only
verified, failing on drift, in strict mode or `NODE_ENV=production`. Same
`write` | `check` duality as D11, applied to `BUILD.ts` itself. This is
Gazelle's job, done live.

**D14, not D1, is what deletes package `BUILD.ts` files.** The six package
`BUILD.ts` files exist for four distinct reasons and only one is the toolchain
import: `plan` is a bare `StandardPackage` destructure, `flow` and `engine`
carry irreducible `deps` edges, `build` carries the workspace template and a
`PackageDefaults` declaration, and `targets` and `build-cli` replace `lib` with a
`Typecheck` because they ship no `dist`. Inferred dependency edges remove the
`deps` edges, so D14 is the only decision that can delete `engine`'s and
`flow`'s.

Two more would disappear if `StandardPackage` gained a `publishable: false`
option. That is a small separate decision worth naming.

## D15 — `sandbox: false` escape hatch that never disables caching

Per target `sandbox: false`, per run a loud CLI flag. **An un-sandboxed target is
still cached.** Its declared input list becomes a promise rather than a
guarantee. Bazel does the same: `tags = ["no-sandbox"]` keeps the action cached.
That is this decision's actual invariant.

**Name the CLI key `dangerouslyNoSandbox`, defaulting to `false`.** incur parses
any leading `--no-` as boolean negation (`packages/build-cli/node_modules/incur/dist/Parser.js:13`
and `:305`), so a schema key named `sandbox` defaulting to `true` would silently
ship a quiet `--no-sandbox` alongside the loud flag. The kebab form
`--dangerously-no-sandbox` parses as an ordinary long option. Reject a bare
`--no-sandbox`.

**The sandbox mode must be key material; the flag must not.** Nothing in key
material distinguishes the two modes today (`Planner.ts:949-966`), so a target
run once with the flag and once without shares a cache entry and can serve a
result produced under the weaker regime to the stricter one. Put the mode in
`capabilities()` (`Planner.ts:835-842`). Keep the flag itself out of key
material and keep caching enabled.

**The per-target field is a `MakeOptions` field feeding `Metadata`, not an attrs
member.** Follow `verbGate`. An attrs member would make declaring the escape
hatch invalidate the target's cache.

Naming follows existing precedent for the loudness: `ExecIrreversible` in
`Changesets.ts`, `unsafe` in `BiomeCheck.ts`.

---

## Non-negotiables

- **Work item zero: the baseline was red, and is fixed.**
  `packages/targets/test/GeneratedRootFiles.test.ts` failed before any decision
  was implemented, 1 failed and 19 passed, because its restated pnpm-workspace
  attrs at `:204-220` omitted `playwright: false`, which `BUILD.ts:65` declares
  and `pnpm-workspace.yaml:14` carries. That made `pnpm test` at `ci.yml:84` red
  and "existing gates stay green" unmeasurable. Wave 0 fixed it in commit
  `4f5aef23`; the file now passes 20 of 20. The test hand-copies root `BUILD.ts`
  attrs, which is how the drift arose, so update it in lockstep with every
  root-config change, including D1's split to `WORKSPACE.ts`.
- Existing gates stay green from work item zero onward.
  `.github/workflows/ci.yml` must pass.
- The secrets model (D9) must not regress. Note that it is dormant, so this is
  currently satisfied by changing nothing; if D9 makes the model usable, the
  requirement becomes real.
- Zero per-package boilerplate must not regress (D13), measured as zero build
  files for 87% of packages.
- House style: `AGENTS.md`, `CLAUDE.md`, both at this repository root. They were
  copied from `/Users/williamcory/flows/` on 2026-08-18. `AGENTS.md` is the
  inherited pi document and its npm and `package-lock.json` instructions were
  corrected to pnpm during the copy; this repository pins
  `packageManager: "pnpm@11.21.0"` and locks with `pnpm-lock.yaml`. Each file
  carries a correction note at the top listing what changed.
- Prose is Google developer-documentation register: short declarative sentences,
  concrete nouns, active voice, no rhetorical flourishes, no em-dash asides.
- New code mirrors `reference/effect` conventions: file structure, export naming
  (`make`/`makeNoop`/`layer`/`layerNoop`), error conventions, JSDoc
  (`@since`/`@category`). The corpus lives at
  `/Users/williamcory/flows/reference/`, not in this worktree.
- Effect is v4 (`effect@4.0.0-rc.108`). Bind services to named variables before
  calling their methods; no nested service yields.
- Commits are emoji + conventional.
