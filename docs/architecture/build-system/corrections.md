# Corrections to DECISIONS.md

Produced by the Wave-0 mapping pass, which verified claims by running the code.
Apply these before implementing. A decision built on a false premise must not be implemented as written.

## Wrong premises

### D5

**Premise (wrong):** "The stated reason for the old default — 'arbitrary target bodies can consult tools, services, or host state that attrs and declared inputs do not identify' — is exactly D2. D2 makes the comment false, which is what licenses the flip."

**Reality:** That is one of two independent stated reasons, and D2 addresses only the first. The docs record a second the decision never mentions: packages/build/docs/workspace/caching.md:112-114 and the per-rule pages (ts-build.md:87, vitest.md:63, typecheck.md:71) say these rules stay uncached because the executable toolchain is not complete key material. Today the only toolchain material in a key is `ambient.lockfile`, a single sha256 of pnpm-lock.yaml (Planner.ts:901-904). Nothing digests the installed node_modules tree or the tool binary, so a lockfile that has not been installed, a partial install, and a locally linked tool all produce identical keys. There are two further blockers D5 does not name: Vitest declares only `test/**/*.test.ts` plus `src/**/*.ts`, leaving 97 files under packages/*/test/ (52 .ts harnesses plus 45 fixtures) undeclared, so a cached test target replays green after a harness edit; and I verified empirically that adding a nested BUILD.ts silently prunes the parent's declared inputs while the parent's tsc still compiles the subtree, which under a cached default replays a stale parent build.

**Should say:** D5 should state four prerequisites, not one: (a) D2's projection, (b) toolchain identity in key material — satisfied for the declared toolchain by D1's ambient fold, still open for the installed binary, (c) declared-input completeness for the nine affected rules, above all Vitest's test directory, and (d) the subpackage-pruning guard from D13. It should also justify the flip by the six rules that actually gain — Typecheck, Vitest, VitestCoverage, BiomeCheck, DepsLint, PackageLint, none of which declares outputs — and record that TsBuild, DtsBuild, and TypedocDocs gain nothing on a fresh checkout, because the cache stores only a JSON success envelope and never restores artifacts (Cache.ts:32-51, Executor.ts:943-964).

### D5

**Premise (wrong):** "TsBuild.ts, Typecheck.ts, and Vitest.ts declare no cache key at all" and the opt-out list "Clean, Dev, Install, Lockfile, NpmPublish, JsrPublish, Changesets, NewPackage, PnpmWorkspaceFile, and the wasm reproducibility gate".

**Reality:** Measured across packages/targets/src. NINE rules declare no cache key and fall through to the default: BiomeCheck:106, DepsLint:104, DtsBuild:88, PackageLint:80, TsBuild:81, Typecheck:78, TypedocDocs:62, Vitest:57, VitestCoverage:89. SIXTEEN already declare cache: false: Changesets:102, Clean:80, Dev:53, Dprint:61, EsLint:72, Install:110, JsrPublish:69, LlmLint:1344, Lockfile:96, NewPackage:453, NpmPublish:74, PackageJson:1136 (PackageJsonWrite), PnpmWorkspaceFile:140, SortPackageJson:63, Tsconfig:131, VitestWatch:63. D5's list omits Dprint, EsLint, LlmLint, SortPackageJson, PackageJsonWrite, Tsconfig, and VitestWatch. Three rules set cache: true (Filegroup:336, DocsParity:324, PackageJsonCheck:1111) and two compute it (GithubCiGen:897, ToolBuild:1074).

**Should say:** D5 should name all nine default-uncached rules as the rules affected by the flip, and state that its opt-out list is illustrative rather than exhaustive — sixteen rules already opt out, and an implementer must not delete an explicit `cache: false` merely because D5 omits that rule. It should also note that the flip must be applied at BOTH Target.ts:687 and Target.ts:715: flipping only :715 leaves implementationDigest recording `["constant", false]` for a rule that is now cacheable, so the digest stops identifying the cache decision it claims to identify.

### D6

**Premise (wrong):** "The import graph is already walked by scripts/circular.mjs."

**Reality:** No such file exists. `ls scripts/` returns browser-check.mjs, check-test-pins.mjs, flows-backup.mjs, pack-release.mjs, release-rehearsal.mjs, set-release-version.mjs, and smoke-release.mjs, plus their tests. What exists is 45 identical per-package copies at packages/*/scripts/circular.mjs, each about 18 lines calling madge over that one package's src with skipTypeImports: true; the root script is `pnpm --recursive --if-present run circular` (package.json:11). There is no repo-wide import graph, no cross-package edge, no type-only import coverage, and no mapping from an import specifier to a target label.

**Should say:** D6 should say the import graph does not exist and must be built: a new repo-wide walker resolving each source file's imports to a target label, run at plan time. It should also state that the per-package madge guards skip type-only imports, so a visibility rule that must cover type imports needs its own resolution rather than a reuse of that tooling.

### D6

**Premise (wrong):** "Tier groups derive from the smthrs.group manifest field, never restated: Visibility.group({ where: (pkg) => pkg.smthrs.group === 'engine' })".

**Reality:** Nothing in the build system reads smthrs.group. Verified: it appears in all 45 package manifests but the only readers in the tree are scripts/pack-release.mjs:39-41, scripts/check-test-pins.mjs:112, and packages/flows/test/index.test.ts. Neither packages/targets/src, packages/build/src, nor packages/build-cli/src contains a manifest reader at all. There is also no visibility system, no tier concept, and no import restriction anywhere in the target model — the only occurrences of the word are a Filegroup doc block stating its absence (Filegroup.ts:23-32) and two doc pages repeating it.

**Should say:** D6 should state that `Visibility.group` requires a new per-directory manifest query, and that the same query is required by D10 to derive the engine release set from the graph. Build it once and share it. D6 should also note the closest existing hook shape is `Metadata.verbGate` (Target.ts:503-506, :716-717, enforced at Planner.ts:877-884) — a per-target allowlist that is deliberately NOT key material, which is the precedent visibility must follow so that changing who may depend on a target does not invalidate that target's cache.

### D7

**Premise (wrong):** "The seven hand-written ci.yml gates become root targets" and "Today these are hand-written steps, which is why GithubCiGen runs in contract (verify-only) mode."

**Reality:** The seven listed gates are all real and all unmodelled (ci.yml:52, :57, :59, :65, :71, :75, :80), but they are only the unmodelled script gates inside the `test` job. ci.yml has 69 steps across 8 jobs; 8 steps map to graph targets and 61 do not. Distinct unmodelled gate commands number 20 `run:` plus 3 gate-carrying `uses:`. Omitted from D5's list: actionlint (:19), the install (:28), the jj init (:41), the clean rebuild (:87), pack-release.mjs (:93), smoke-release.mjs (:94), four rust verbs (:112-121), three wasm-repro steps (:153-171), and the bun suite loop (:214-217). `pnpm run browser` appears twice (:57 and the whole browser job at :237). Separately, the causal claim is misleading: GithubCiGen's own JSDoc (:837-877) gives a different and larger reason for contract mode — a hand-written pipeline carries comments, continue-on-error advisories, matrix jobs, and platform lanes that no declaration reproduces.

**Should say:** D7 should say the seven are the script gates in the `test` job, name the ~20 unmodelled commands as the full surface, note that `pnpm run browser` appears twice so modelling it retires two steps and one job, and state that landing D7 is necessary but far from sufficient for D11's write mode. It must also record the fact that makes D7 operationally inert as written: `//:ci` is never executed by any CI step. GithubCiGen's kinds are [build, lint]; ci.yml:50 runs the `docs` verb and ci.yml:297 runs `ci "//packages/..."`, and I measured that pattern returning 272 labels with zero `//:` among them against 280 total. A step that actually plans `//:ci` must be added or the contract stays dead.

### D9

**Premise (wrong):** "Turborepo's envMode: 'strict' makes reading an undeclared environment variable fail. We have no equivalent."

**Reality:** Exec already gives a child a closed 19-name world: the frozen 14-name `inheritedEnvironmentNames` (Exec.ts:343-358) plus five forced locale and color values, merged with the payload env, then a denylist pass, then secrets. The real gap is narrower — those 14 inherited VALUES never enter key material. Planner.ts:897-906 carries node version, platform, arch, the lockfile digest, and an implementation fingerprint, and no environment value appears anywhere in a key. Separately, two other spawn paths carry weaker policies and would leave the guarantee unmet if only Exec.ts were edited: LlmLint's spawnEnvironment copies all of process.env and deletes a denylist (LlmLint.ts:443-467), and the package manager builds its own 15-name allowlist plus every ${NAME} referenced by the project .npmrc (build/src/PackageManager.ts:749-798). A third, Workspace.runGit (Workspace.ts:121-137), also spreads process.env.

**Should say:** D9 should say the allowlist exists and the unkeyed-input gap is the 14 inherited values, then require those values to become declarable and to enter key material. It must name all three spawn paths as in scope, because an allowlist implemented only in Exec.ts claims a closed environment the repo does not have.

### D9

**Premise (wrong):** "Secrets keep their existing model (Secret('NAME') + placeholder + substituting proxy). That model is better than every tool compared and must not regress."

**Reality:** The model is real, well-tested, and has ZERO production callers. No target attrs schema accepts a Secret.Declaration except GithubCiGen (which only names the variables in the generated workflow, :361-363) and RemoteCache config. The root BUILD.ts declares cacheToken and cacheUrl and passes them only to GithubCiGen. `Exec.Payload.secrets` is therefore always empty in production and `withSecretEnvironment` always takes its zero-secret fast path (Exec.ts:789). Also, SecretProxy.ts:10-13 claims the in-process substitution seam is applied by every outbound request the build makes, "which today means the remote-cache client" — that is false; the client sets `authorization: Bearer ${this.token}` from a raw string read in Cli.prepare (Cache.ts:1173-1174, Cli.ts:103-106) and never touches a vault.

**Should say:** D9 should say the secret model is dormant: "must not regress" is currently satisfiable by changing nothing. If the intent is that the model becomes usable, that is unbuilt work — a target-level `secrets` attr and at least one production caller — and D9 should scope it. It should also require correcting the false module doc at SecretProxy.ts:10-13, and add one requirement a sandbox makes newly load-bearing: the substituting proxy binds loopback (127.0.0.1), so whatever D2 builds must explicitly keep loopback reachable or every declared secret breaks silently.

### D11

**Premise (wrong):** "GeneratedFile already has write | check modes."

**Reality:** True but misleading. `GeneratedFile.Mode` (:34-44, constructor default "write") is dead code — no target imports it. Tsconfig (:57-60) and PnpmWorkspaceFile (:61-64) each redeclare their own Schema.Literals(["write","check"]) with the OPPOSITE default, "check". PackageJson uses a three-valued SyncMode (:570) and GithubCiGen a three-valued OutputMode (:47-49). There are four mode vocabularies. Tsconfig and PnpmWorkspaceFile are also ONE target with a mode attr, not a gazelle-style check/write pair — only PackageJson ships the pair, hand-rolled in PackageJson.targets (:1466-1515). Neither `Mode` nor `generateFile` is exported from the Smithers namespace, so a BUILD.ts author cannot reach either.

**Should say:** D11 should say there are four mode vocabularies and one dead shared one, that unifying them requires reconciling opposite defaults (choose "check"), that only PackageJson implements the pair and its shape should be lifted into `generateFile`, and that the shared vocabulary must be exported from Smithers.ts before any BUILD.ts can use it.

### D11

**Premise (wrong):** "GithubCiGen is stuck in contract mode because of D7; once D7 lands it moves to write."

**Reality:** Write mode cannot reproduce the checked-in ci.yml. The Job schema models only id, name, runsOn, timeoutMinutes, continueOnError, and steps (:133-156); the Step schema only name, uses, run, with, env (:92-98). There is no needs, permissions, job-level env, strategy or matrix, environment, outputs, defaults, step if, step id, step shell, or working-directory, and comments are lost entirely. ci.yml carries 60+ load-bearing comment lines and 8 jobs including rust, wasm-repro, bun, browser, node-macos, node-windows, and smthrs-shadow, plus 4 continue-on-error uses, a Docker actionlint action, a clean-dist rebuild loop, and a pack+smoke release step. release.yml is further out of reach: Attrs models only push.branches, pull_request, and bare workflow_dispatch, with no push.tags, no workflow_dispatch.inputs, no top-level permissions, no job environment.

**Should say:** D11 should say write mode requires a substantially larger render model and an answer for comments, and that D7 is necessary but not sufficient. The honest interim is to keep contract mode and make the contract strong — every gate declared and a requiredJobs list — rather than to generate a weaker file. It should also record the hidden coupling: scripts/pack-release.test.mjs:152-157 is a cross-workflow parity gate whose extractor recognises only `pnpm run <script>`, `pnpm test`, and `node [--test ]scripts/*.mjs`, so converting gates to smthrs invocations makes it pass vacuously and silently stop protecting release.yml.

### D12

**Premise (wrong):** The example `export const npm = Smithers.NpmLock({ packageManager, lockfile })`, and the framing that node_modules being one opaque tree is the only thing making D2 unaffordable.

**Reality:** Two problems. First, the example threads `packageManager` into a target declaration while D1 states no target attr threads it any more — the two decisions contradict each other. Second, D12 is blocked by four mechanisms it never mentions, three of them deliberate safety properties with written rationales: declared-input expansion refuses node_modules outright (Input.ts:544 skips the directory name, :625 short-circuits any pattern rooted in it); declared-output capture refuses symbolic links at the declared root and anywhere inside the tree (ToolBuild.ts:657-662, :761-763) and pnpm's node_modules is a symlink farm; nothing may declare an output under the reserved roots {.flows, .git} (Target.ts:99) and the store lives at .flows/store; and the manager exposes only workspace-wide fetch and link with no per-package verb, where npm, bun, and yarn are makeNoop refusals that fail every operation. Nothing parses pnpm-lock.yaml either — it is only digested, and GithubWorkflow.ts:18-26 records that a YAML dependency was rejected on dependency-policy grounds.

**Should say:** D12 should drop `packageManager` from the example (`NpmLock({lockfile})`, reading the registry), and should state that per-package addressing must not relax any of the three safety guards. The honest design is a lockfile-derived handle content-addressed on the lockfile entry and its transitive closure, not a file set under node_modules — which requires a hand-written lockfile scanner following the GithubWorkflow.ts precedent, and which works only for pnpm until the other managers stop being refusals.

### D13

**Premise (wrong):** "Any folder with a BUILD.ts is a buildable, cacheable unit" framed as new work, and "PackageDefaults + StandardPackage = 0 files".

**Reality:** Half of D13 already ships, which I confirmed by running the real CLI against a scratch workspace: `//pkg/src/internal:lib` resolves today, `//...` enumerates it, label resolution is depth-agnostic (Label.ts:25-62, Workspace.ts:752-755, :1117-1128), and Bazel's subpackage rule for globs is fully implemented (Input.ts:401-415, :474-491, :539, :645). A nested BUILD.ts is also naturally additive, because `eligible` checks only `<directory>/BUILD.ts` (Workspace.ts:1014-1019). Separately, the zero-files claim is not literally true: the repo has 8 BUILD.ts files (root, lint, and six under packages/), 39 of 45 packages have none, and all 45 still hand-write six per-package config files — 270 files. MOST IMPORTANTLY, the shipped half hides a live bug: I verified that adding pkg/src/internal/BUILD.ts silently removed pkg/src/internal/b.ts from `//pkg:lib`'s declared inputs while the parent's `tsc -b` still compiles that subtree.

**Should say:** D13 should say the label layer and glob pruning already exist, and that the unbuilt work is synthesis for marker-less directories, the per-unit manifest, and the cross-unit dependency bookkeeping. It should state the honest property as zero build files for 87% of packages, scoped to build-tool config. And it must add the missing correctness requirement: a target whose declared glob is pruned by a subpackage boundary must depend on a target in that subpackage, or the plan fails — otherwise adding a folder unit produces a silently stale parent build, and D5's flip turns that into a stale green.

### D1

**Premise (wrong):** "packages/build-cli/src/Workspace.ts currently calls buildEntry(canonical, 'BUILD.ts') twice for config resolution; discovery must learn WORKSPACE.ts."

**Reality:** Correct but incomplete, and the decision omits three consequences. The two calls are at :477 and :514, but there is a third hard dependency at :794 where `this.buildFiles` filters the workspace listing to `BUILD.ts` and `*/BUILD.ts`, and a fourth in `Input.isPackage` (Input.ts:401-415) which compares the basename `BUILD.ts` exactly to decide the glob package boundary — a WORKSPACE.ts added to that boundary check would change every glob's scope. Three consequences go unmentioned. (a) Target attrs are key material (Planner.ts:960), and the whole PackageManager declaration currently rides there; removing the attr without folding the toolchain into `ambient` (:897-906) silently drops the toolchain from every key, so a pnpm version bump stops invalidating anything. (b) `layers()` (:812-833) derives the Install/Lockfile layer identity from `attrs.packageManager.name@version` and would return []. (c) `declaredToolchain` (engine.ts:234-264) falls back to pnpm `>=0.0.0` when the attr is absent, turning every declared version requirement into "any version" with no error. Also, `smthrs install` already ignores the declared toolchain — Cli.ts:230-241 passes none — so that is a wire to build, not to preserve.

**Should say:** D1 should require the toolchain registration to become the source for ambient key material, for `layers()`, and for `declaredToolchain`, in the same change that removes the attr, and should state the intended net effect on cache keys explicitly (unchanged). It should also note that moving Install, Lockfile, and PnpmWorkspace out of root BUILD.ts deletes the labels `//:nodeModules`, `//:lockfile`, and `//:workspace` unless WORKSPACE.ts exports are registered as targets — and that `nodeModules` is the second entry in the hardcoded default-target candidate list (Workspace.ts:992-999), so a bare `//` stops resolving, which packages/build/docs teaches.

### D15

**Premise (wrong):** "Per target sandbox: false, per run --dangerously-no-sandbox. Naming follows existing precedent... plain boolean attr, loud CLI flag."

**Reality:** A naming trap and a soundness gap. incur parses any leading `--no-` as boolean negation (verified in packages/build-cli/node_modules/incur/dist/Parser.js:13 and :305), so a schema key named `sandbox` defaulting to true would silently also ship a quiet `--no-sandbox` alongside the loud flag. Separately, nothing in key material distinguishes the two modes today (Planner.ts:949-966), so a target run once with the flag and once without would share a cache entry and could serve a result produced under the weaker regime to the stricter one.

**Should say:** D15 should specify the CLI key as `dangerouslyNoSandbox` defaulting to false, whose kebab form is parsed as an ordinary long option, and state that a bare `--no-sandbox` must be rejected. It should also require the sandbox MODE to be key material — in `capabilities()` (Planner.ts:835-842) — while keeping the flag itself out of key material and keeping caching enabled, which is D15's actual invariant. Note the per-target attr must be a MakeOptions field feeding Metadata, following verbGate, not an attrs member, or declaring it invalidates the target's cache.

### D2

**Premise (wrong):** "macOS has sandbox-exec; Linux has namespaces."

**Reality:** Unsupported by anything in this repository. A repo-wide grep for sandbox-exec, seatbelt, bubblewrap, chroot, unshare, landlock, pledge, firejail, and CLONE_NEW returns zero hits outside DECISIONS.md itself; the word sandbox appears in the build packages only in three prose comments in Install.ts describing a future one. sandbox-exec is also a deprecated Apple interface. The spec vault's own tier plan names bubblewrap and Microsandbox for Linux and virtual-fs seeding for the browser (docs/specs/Concepts/Effect Taxonomy.md:60-86), and its single sandbox-exec mention describes a different repo's approach and judges our permission kernel stronger (Concepts/Trust Granularity.md:19). The closest real prior art in this repo is EngineStore.WorkspaceSandbox, whose own doc states it is a determinism model and NOT a security boundary and that a spawned native process is outside it — precisely the build system's case.

**Should say:** D2 should specify copy-in projection — seed a scratch root with exactly the declared inputs, run there, copy declared outputs back — following WorkspaceSandbox and the vault's tier plan, and should not name sandbox-exec. It should state plainly that this is a determinism boundary, not a security boundary. It should also record that the hard cost is not in Exec.ts but in declaration completeness: inputs are auto-derived by walking attrs (Target.ts:509-555) and StandardPackage declares only sources, tests, and four config files, so tsc, vitest, eslint, and dprint all read node_modules, tsconfig.base.json, and dependency declarations that no target declares. D12 is a hard prerequisite, not a parallel decision, and D2 landing before it turns every packages/* target red on day one.

### D4

**Premise (wrong):** "Also accept Vitest('vitest.config.ts') — a path alone — for the common case. Apply the same duality across the catalog wherever a tool already has a config file format."

**Reality:** A path alone cannot supply the declared inputs the target needs. Vitest's attrs are tests, sources, deps, config, environment, passWithNoTests, and cwd; the path form names only `config`. The build system does not parse vitest.config.ts, so it cannot derive the `include` patterns that would tell it which tests exist. A path-form target with empty or omitted tests and sources is a target whose declared inputs are wrong — harmless today because the rule is uncached and unsandboxed, actively dangerous after D5's flip and D2's projection.

**Should say:** D4 should require the path form to produce a COMPLETE declared-input set derived from the same conventions StandardPackage uses, with the named config file added — never an omitted one — and should state explicitly that the tool's config file is not parsed, so the globs come from convention rather than from the file. It should also be sequenced after D1, since a path form cannot name a package manager while the attr still exists.

### Non-negotiables

**Premise (wrong):** "Existing gates stay green. .github/workflows/ci.yml must pass." and "House style: AGENTS.md, CLAUDE.md."

**Reality:** Both are false in this worktree. I ran the suite: packages/targets/test/GeneratedRootFiles.test.ts fails right now, 1 failed / 19 passed, because its restated pnpm-workspace attrs at :204-220 omit `playwright: false` which BUILD.ts:65 declares and pnpm-workspace.yaml:14 carries. `pnpm test` at ci.yml:84 is therefore red before any decision is implemented. And neither AGENTS.md nor CLAUDE.md exists at /Users/williamcory/flows-buildsys — the only AGENTS.md in the tree is apps/ui/AGENTS.md; the root copies live in the outer repo, where AGENTS.md is the inherited pi document that still describes npm and package-lock.json rather than pnpm.

**Should say:** The non-negotiables should record that the baseline is red and name the one failing assertion as work item zero, since "stays green" is unmeasurable until it is fixed. They should also either place AGENTS.md and CLAUDE.md in this worktree or cite their real path, and note that the outer AGENTS.md's npm instructions are stale against this repo's pnpm@11.21.0 migration.

## Blocked, with the honest alternative

### D2 — implement input-projected execution using sandbox-exec / namespaces

**Why:** The named mechanisms appear nowhere in this repository, its docs, or the spec vault except as a description of a different repo's approach. macOS sandbox-exec is a deprecated Apple interface. The repo's own institutional knowledge (docs/specs/Concepts/Effect Taxonomy.md:60-86) specifies a different tier plan: browser seeds a virtual fs with the declared reads, sandboxed node bind-mounts or copies in, bare node falls back to detection-by-diff. The nearest in-repo prior art, EngineStore.WorkspaceSandbox, states in its own module doc that it is a determinism model and NOT a security boundary, and that a spawned native process is outside it.

**Alternative:** Build copy-in projection: seed a scratch root with exactly the declared inputs, run the child there, copy declared outputs back, all under the confinement discipline SafeFs already implements. Describe it honestly as a determinism boundary that catches the undeclared-read bug class, not as a security sandbox. That is what D2's own fallback sentence already licenses ("A weaker first form (project declared inputs, deny the rest) still catches the bug class") — make it the primary specification rather than the fallback.

### D2 — make projection the default for existing targets

**Why:** Declared inputs are auto-derived by walking attrs (Target.ts:509-555), and StandardPackage declares only sources, tests, and four config files. Typecheck's attrs are srcs, deps, tsconfig; tsc additionally reads the extended base tsconfig, node_modules/typescript, and every dependency's declarations. Every catalog rule invokes its tool through PackageManager.exec (`pnpm exec tsc`), and no target declares node_modules — which Input.ts refuses to expand into anyway. Strict projection turns all 272 targets under //packages/... red on day one, and it will read as a regression across the whole repo rather than as the bug being caught.

**Alternative:** Land projection as opt-in with the per-target sandbox field defaulting to false, prove it on one narrow target (a ToolBuild genrule with fully declared inputs, such as the Rust lane's), and flip rules to projected one at a time as D12 completes each rule's input closure. Sequence D12 before any default change and say so in D2.

### D5 — flip the cache default on the strength of D2 alone

**Why:** Two of the four real prerequisites are not addressed by D2 at all. Toolchain identity in key material is only the lockfile digest, so an uninstalled or partially installed lockfile and a locally linked tool all key identically. And declared-input completeness is broken today in a way that produces stale green test runs immediately: 97 files under packages/*/test/ are inputs to no test target. A fourth prerequisite, the subpackage-pruning hazard, I verified empirically.

**Alternative:** Gate the flip on the three prerequisites this plan schedules — ambient toolchain (Wave 1), the pruning guard (Wave 3), and declared-input completeness (Wave 4) — rather than on D2. Flip all nine default-uncached rules, but justify the change by the six that actually gain wall clock, and record that TsBuild, DtsBuild, and TypedocDocs remain inert until an artifact store exists.

### D5 — expect a wall-clock win on TsBuild, DtsBuild, TypedocDocs

**Why:** The cache stores only a JSON success envelope (Cache.ts:32-51). There is no artifact store and no output restoration. A hit for a target with declared outputs requires those outputs to already be on disk and to still match the recorded digest (Executor.ts:943-964, and a failing output check silently falls through to a normal run). On a fresh CI checkout there is no dist, so every build of these three misses.

**Alternative:** State that the three build rules become cacheable but inert until an artifact store lands, and file the artifact store as a separate decision. Present D5's benefit as Typecheck, Vitest, VitestCoverage, BiomeCheck, DepsLint, and PackageLint, none of which declares outputs.

### D6 — enforce visibility by reusing scripts/circular.mjs

**Why:** There is no root scripts/circular.mjs. There are 45 per-package copies, each running madge over one package's src with skipTypeImports: true. No repo-wide graph, no cross-package edge, no type-only coverage, and no specifier-to-label mapping exists.

**Alternative:** Build a new import walker in packages/build-cli and enforce at plan time inside Planner's visit, where dependency edges already resolve to labels. Budget it as new work, not as a hook into existing tooling, and decide the type-only-import policy explicitly since the existing madge guards skip them.

### D6 — derive tier groups from smthrs.group without restating them

**Why:** No part of the build system reads any package manifest. smthrs.group exists in all 45 manifests but the only readers are two scripts and one test.

**Alternative:** Build a per-directory manifest query as shared infrastructure. D10 needs the identical mechanism to derive the engine release set from the graph, and D13's PackageDefaults needs it to pass name and version to the macro. Build it once, in one place, and have all three consume it.

### D7 — model seven gates so GithubCiGen can leave contract mode

**Why:** Two independent problems. The seven are a subset: ~20 distinct run commands and 3 gate-carrying actions are unmodelled across 8 jobs. And landing D7 changes nothing operationally, because //:ci is never executed by any CI step — its kinds are [build, lint], while ci.yml runs only the docs verb and `ci //packages/...`, a pattern that excludes every //: root target. I measured 272 labels in that pattern against 280 total, with zero //: among them.

**Alternative:** Do three things in one change: model the seven as ToolBuild declarations, add a CI step that actually plans //:ci, and strengthen the contract with a full gate list plus a requiredJobs list. That delivers real gate coverage now without depending on write mode. Also rewrite the pack-release parity test in the same change, or it goes vacuously green the moment a gate becomes a smthrs invocation.

### D10 — support changeset-like versioning and changelogs

**Why:** There is no changesets installation to build on: no .changeset/ directory, no @changesets/* in any package.json or in pnpm-lock.yaml, no config, and no CHANGELOG.md anywhere. packages/targets/src/Changesets.ts models only status and version, shells out to `pnpm exec changeset version`, and has zero call sites. This is a from-scratch build behind a new third-party dependency, not a wiring job.

**Alternative:** Either adopt @changesets/cli explicitly as a dependency decision with its own config, or state that versioning stays native and build on scripts/set-release-version.mjs:45-76, which already implements exactly the Nx updateDependents: auto behaviour D10 asks for, across all four dependency fields, with protocol ranges correctly excluded, and is already CI-gated. Do not describe the existing mechanism as missing.

### D10 — wire NpmPublish into the package macro so //packages/journal:publish exists

**Why:** Three independent blockers. NpmPublish runs through ExecIrreversible and the executor's layer stack does not provide ExecIrreversibleLive (verified absent from Executor.ts:239-254), so the action resolves to nothing — a target that plans and then fails at interpretation. It publishes a DIRECTORY via `pnpm publish` in dirname(packageJson.path), while this repo publishes tarballs built from a staging copy whose manifest was rewritten; with source-first manifests, running it as written would publish TypeScript source as the package entry. And the macro has no manifest: StandardPackage.Options carries no name, version, or group, and PackageDefaults.expand hands the macro one static attrs record shared by every match.

**Alternative:** Fix all three before wiring: gate ExecIrreversibleLive into the executor behind the run verb (D15's loud-flag treatment), give NpmPublish a tarball or staged-directory input plus the `pnpm view` idempotence probe release.yml already relies on, and teach PackageDefaults.expand to pass the matched directory's name, version, and smthrs.group. Verify verbGate holds transitively so ci graphs stay clean.

### D10 — replace pack-release.mjs's directory walk with the graph

**Why:** The dependency graph over the release set is NOT acyclic. scripts/pack-release.test.mjs:125-140 pins `kernel -> platform-browser` as a known, accepted cycle, and pack-release.mjs:93-111 implements a deliberate cycle-entry rule with an alphabetical tiebreak to order through it. A planner that refuses cycles outright cannot order this workspace at all.

**Alternative:** Either reproduce the cycle-entry behaviour exactly in whatever graph ordering replaces it, and keep the pinning test, or keep pack-release.mjs as the ordering implementation behind a graph-declared target. Also preserve assertBuilt, the publicationManifest export rewrite, and the --list/--names CLI the release runbook drives.

### D11 — GithubCiGen moves to write mode once D7 lands

**Why:** The render model cannot express the checked-in workflow. No needs, permissions, job-level env, strategy or matrix, environment, outputs, defaults, step if, step id, step shell, or working-directory; comments are dropped entirely, and ci.yml carries 60+ load-bearing comment lines documenting why each gate exists. release.yml is further out of reach — no push.tags, no workflow_dispatch.inputs, no top-level permissions, no job environment, no step-level if.

**Alternative:** Keep contract mode and make the contract strong: declare every gate and a requiredJobs list, and add the CI step that actually runs it. Treat the render-model expansion and the comment-preservation question as a separate, larger decision. Generating a weaker ci.yml than the one checked in would be a net loss of gate coverage.

### D12 — every npm package is a target, as a peer of D2

**Why:** Four blockers, three of them deliberate safety properties with written rationales: input expansion refuses node_modules, output capture refuses symlinks anywhere in a captured tree while pnpm's node_modules is a symlink farm, nothing may declare an output under .flows where the store lives, and the manager exposes only workspace-wide fetch and link with npm, bun, and yarn as makeNoop refusals. Nothing parses pnpm-lock.yaml, and a YAML dependency was previously rejected on policy grounds.

**Alternative:** Sequence D12 as a hard prerequisite of D2, not a peer. Implement npm(name) as a lockfile-derived handle content-addressed on the lockfile entry and its transitive closure, so no safety guard is relaxed. Write a targeted lockfile scanner following the GithubWorkflow.ts precedent. Accept that only pnpm can be made granular first, and say so.

### D13 — folder units as new work, at zero boilerplate cost

**Why:** The label layer and glob pruning already ship — verified by running the CLI — so the decision misidentifies its own scope. And the shipped half carries a live bug the decision does not mention: adding a nested BUILD.ts silently prunes the parent's declared inputs while the parent's tsc still compiles the subtree, which D5's flip converts into a stale green build.

**Alternative:** Rescope D13 to the three genuinely missing pieces: synthesis for marker-less directories, a unit-shaped manifest (which the current PackageJson cannot express — it demands a publishable npm name, a literal semver, and a build target with outDir and format), and cross-unit dependency bookkeeping. Add the pruning guard as a hard requirement, and sequence it before D5's flip rather than after.

### D14 — dep lists self-update during normal runs

**Why:** Not blocked, but the decision misattributes the win. D1 removes the toolchain import from six package BUILD.ts files; it does not delete any of them. The files exist for four distinct reasons, and only one is the import: plan is a bare StandardPackage destructure, flow and engine carry irreducible deps edges, build carries the workspace template and a PackageDefaults declaration, and targets and build-cli replace lib with a Typecheck because they ship no dist. D14 is the decision that removes the deps edges, and therefore the only one that can delete engine's and flow's BUILD.ts.

**Alternative:** State in D1 that it makes BUILD.ts files toolchain-free but deletes none, and state in D14 that inferred dependency edges are what remove them. Note that two more would disappear if StandardPackage gained a `publishable: false` option, which is a small separate decision worth naming.

### Non-negotiable — existing gates stay green

**Why:** The baseline is red before any work starts. packages/targets/test/GeneratedRootFiles.test.ts fails on a one-line omission in its hand-copied pnpm-workspace attrs, which makes `pnpm test` at ci.yml:84 red on this worktree.

**Alternative:** Fix it as work item zero (Wave 0), before any decision is implemented, so that "stays green" becomes a measurable property. Record in that commit that the file hand-copies root BUILD.ts attrs and must be updated in lockstep with every root-config change, including the D1 split to WORKSPACE.ts, since that is exactly how the drift arose.

