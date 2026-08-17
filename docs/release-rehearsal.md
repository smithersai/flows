# Release rehearsal receipt

## Revalidation: 2026-08-16, lane `c3`

**Commit:** `4b6f7a42d22ef4ae9c1fe196569ed726dce6de75`, the reachable rebased
equivalent of the pre-rebase receipt commit `56382ff12162e864a96646534c70b1c3e8b50b29`.
**Host:** Node 22.19.0, pnpm 11.21.0. **Published:** nothing.

The committed implementation above was revalidated from this isolated worktree.
The full release-specific dry path completed with this exact command (its transcript
is outside the repository at `/tmp/flows-c3-release-followup.c82b4Q/transcript.json`):

```sh
node scripts/release-rehearsal.mjs --tag v0.1.0 \
  --node /Users/williamcory/.nvm/versions/node/v22.19.0/bin \
  --runner-temp /tmp/flows-c3-release-followup.c82b4Q \
  --skip "Initialize colocated jj repository" \
  --skip "Typecheck all workspaces" --skip "Test all workspaces" \
  --skip "Lint all workspaces" --keep-going
```

It exited with the publish step skipped by `if: env.DRY_RUN != 'true'`; install,
tag validation, circular and browser guards, release-script tests, the clean
all-workspace build, pack-and-smoke, publish-plan computation, and the explicit
"Report the skipped publication" step all exited 0. The clean-build pack produced
the same 23 tarballs and smoke-tested every ESM/CJS entry plus declarations.

The omitted three broad gates were separately attempted: `pnpm run check` ran for
711 seconds and failed only in the unowned `examples/` package (`src/02-run-durably.ts`
and four sibling examples have `Effect<…, any>` where `Effect<…, never>` is required;
`src/durable-layer.ts` cannot resolve `@smthrs/flows-next/NodeRuntime`). No release
lane file caused or was changed to address that inherited failure.

For the requested prerelease rehearsal identifier, a local-only annotated tag
`v0.1.0-next.0-rc` was created at this commit and the workflow's tag gate was run
against it. It correctly refused the current `0.1.0` engine manifests; the human
runbook's version-bump step is required before that prerelease tag can pass.

**Date:** 2026-08-16 (UTC)
**Commit:** `3fcf5fcd6294d07cc5d9b953cf41961f42922673` — `📝 docs: reconcile release status, retention, and backend claims`
**Host:** macOS 26.2, arm64, Node 22.19.0 (the CI pin), pnpm 11.21.0
**Published:** nothing. No tag was pushed, no npm request was made, no registry state changed.

This receipt closes the evidence half of audit item C4 ("release path never run"). It
records a full pack, an install-and-import smoke of every engine tarball in a scratch
project outside the repository, and a no-publish rehearsal of
`.github/workflows/release.yml`. The steps a human runs to publish for real are in the
[release runbook](release-runbook.md).

What the rehearsal changed, because running it found these:

- `.github/workflows/release.yml` gained a `workflow_dispatch` dry-run path (§4).
- `scripts/smoke-release.mjs` now loads every packed tarball, not only the barrel, and
  installs the optional peers a consumer needs (§3).
- `scripts/release-rehearsal.mjs` executes a workflow job locally without publishing.
- `scripts/set-release-version.mjs` moves the version and the exact internal ranges
  together, which is the precondition the validation gate enforces (§5).

## 1. Clean frozen install

```sh
pnpm install --frozen-lockfile
```

Exit 0 in 2m 21s: 1700 packages resolved, 1693 reused, 0 downloaded. The lockfile at
this commit is coherent with the manifests.

## 2. Pack the engine train

```sh
node scripts/pack-release.mjs /tmp/c3-release-packs
```

Exit 0. Run twice: standalone, and again inside the workflow rehearsal in §4 (step 18,
into `/tmp/c3-rehearsal/release-packs`), with the same 23 tarballs both times.
23 tarballs plus `manifest.json`. Membership is `smthrs.group === "engine"`; the
19 agent-group and 3 tooling packages are not packed. The order below is the publication
order the manifest records — a workspace follows every workspace dependency it declares,
except the one documented `kernel -> platform-browser` cycle.

| # | Package | Version | Tarball | Size | Smoke result |
|---|---------|---------|---------|------|--------------|
| 1 | `@smthrs/canonical-next` | 0.1.0 | `smthrs-canonical-next-0.1.0.tgz` | 9.5 kB | passed — ESM, CJS, and declarations |
| 2 | `@smthrs/capability-next` | 0.1.0 | `smthrs-capability-next-0.1.0.tgz` | 28.8 kB | passed — ESM, CJS, and declarations |
| 3 | `@smthrs/crypto-next` | 0.1.0 | `smthrs-crypto-next-0.1.0.tgz` | 5.8 kB | passed — ESM, CJS, and declarations |
| 4 | `@smthrs/artifacts-next` | 0.1.0 | `smthrs-artifacts-next-0.1.0.tgz` | 75.8 kB | passed — ESM, CJS, and declarations |
| 5 | `@smthrs/database-next` | 0.1.0 | `smthrs-database-next-0.1.0.tgz` | 48.2 kB | passed — ESM, CJS, and declarations |
| 6 | `@smthrs/jj-next` | 0.1.0 | `smthrs-jj-next-0.1.0.tgz` | 1404.3 kB | passed — ESM, CJS, and declarations |
| 7 | `@smthrs/journal-next` | 0.1.0 | `smthrs-journal-next-0.1.0.tgz` | 142.8 kB | passed — ESM, CJS, and declarations |
| 8 | `@smthrs/keys-next` | 0.1.0 | `smthrs-keys-next-0.1.0.tgz` | 6.1 kB | passed — ESM, CJS, and declarations |
| 9 | `@smthrs/observability-next` | 0.1.0 | `smthrs-observability-next-0.1.0.tgz` | 27.0 kB | passed — ESM, CJS, and declarations |
| 10 | `@smthrs/plan-next` | 0.1.0 | `smthrs-plan-next-0.1.0.tgz` | 177.0 kB | passed — ESM, CJS, and declarations |
| 11 | `@smthrs/flow-next` | 0.1.0 | `smthrs-flow-next-0.1.0.tgz` | 324.5 kB | passed — ESM, CJS, and declarations |
| 12 | `@smthrs/engine-next` | 0.1.0 | `smthrs-engine-next-0.1.0.tgz` | 105.9 kB | passed — ESM, CJS, and declarations |
| 13 | `@smthrs/run-store-next` | 0.1.0 | `smthrs-run-store-next-0.1.0.tgz` | 111.2 kB | passed — ESM, CJS, and declarations |
| 14 | `@smthrs/step-cache-next` | 0.1.0 | `smthrs-step-cache-next-0.1.0.tgz` | 50.9 kB | passed — ESM, CJS, and declarations |
| 15 | `@smthrs/sync-next` | 0.1.0 | `smthrs-sync-next-0.1.0.tgz` | 141.1 kB | passed — ESM, CJS, and declarations |
| 16 | `@smthrs/kernel-next` | 0.1.0 | `smthrs-kernel-next-0.1.0.tgz` | 161.8 kB | passed — ESM, CJS, and declarations |
| 17 | `@smthrs/engine-store-next` | 0.1.0 | `smthrs-engine-store-next-0.1.0.tgz` | 780.7 kB | passed — ESM, CJS, and declarations |
| 18 | `@smthrs/platform-browser-next` | 0.1.0 | `smthrs-platform-browser-next-0.1.0.tgz` | 46.6 kB | passed — ESM, CJS, and declarations |
| 19 | `@smthrs/platform-bun-next` | 0.1.0 | `smthrs-platform-bun-next-0.1.0.tgz` | 8.3 kB | passed — ESM, CJS, and declarations |
| 20 | `@smthrs/platform-node-next` | 0.1.0 | `smthrs-platform-node-next-0.1.0.tgz` | 84.7 kB | passed — ESM, CJS, and declarations |
| 21 | `@smthrs/sandbox-next` | 0.1.0 | `smthrs-sandbox-next-0.1.0.tgz` | 40.1 kB | passed — ESM, CJS, and declarations |
| 22 | `@smthrs/time-travel-next` | 0.1.0 | `smthrs-time-travel-next-0.1.0.tgz` | 213.6 kB | passed — ESM, CJS, and declarations |
| 23 | `@smthrs/flows-next` | 0.1.0 | `smthrs-flows-next-0.1.0.tgz` | 15.0 kB | passed — ESM, CJS, and declarations |

## 3. Smoke every tarball

```sh
node scripts/smoke-release.mjs /tmp/c3-release-packs
```

Exit 0 on Node 22.19.0, standalone and again inside the workflow rehearsal in §4. The
smoke creates a scratch project under the system temp
directory — outside this repository and with no access to the workspace — installs all
23 tarballs into it with every internal `@smthrs/*` edge overridden to the tarball under
test, then loads each package through its published entry twice: `await import(name)` and
`require(name)`.

All 23 packages loaded on both module systems. The tail of the run:

```
smoke ok   @smthrs/time-travel-next@0.1.0 (smthrs-time-travel-next-0.1.0.tgz, 213.6 kB)
smoke ok   @smthrs/flows-next@0.1.0 (smthrs-flows-next-0.1.0.tgz, 15.0 kB)

release smoke holds: 23 tarballs install, import, and typecheck on node 22.19.0.
```

The type-level consumer (`smoke.mts`, `tsc --module NodeNext`) also compiles against the
installed declarations.

Two defects in the previous smoke were found and fixed by this rehearsal, in
`scripts/smoke-release.mjs`:

1. It only loaded `@smthrs/flows-next`. 22 of 23 tarballs were never imported at all, so
   a package could have shipped an unloadable entry and the release would have passed.
2. `@smthrs/platform-bun-next` does not load in a consumer project without
   `@effect/platform-bun`, which it declares as an *optional* peer. The smoke now
   installs the optional peers the packed manifests declare, which is what a consumer is
   told to do, and fails if a packed entry cannot resolve. Reproduced before the fix:
   `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@effect/platform-bun'`.

## 4. Workflow rehearsal, no publish

### The dry-run path added to `release.yml`

`release.yml` previously fired only on `push: tags: v*`, so the only way to execute it was
to publish. It now also accepts `workflow_dispatch` with two inputs:

- `releaseTag` — the tag to validate. On a dispatch `github.ref_name` is a branch name, so
  the tag comes from the input; it defaults to the dispatched ref.
- `dryRun` — defaults to **true**. Every gate, the clean build, the pack, and the smoke run
  identically; only `Publish packages in dependency order` is skipped, by its own
  `if: env.DRY_RUN != 'true'`.

A tag push cannot enter the dry-run path: `DRY_RUN` is
`github.event_name == 'workflow_dispatch' && inputs.dryRun`, which resolves to `false` for
a push. The publish plan (set, order, version, dist-tag) is computed on both paths, so a
dry run reports exactly what a real run would do.

`scripts/release-rehearsal.test.mjs` asserts both halves against the real `release.yml`
and runs in CI, so an edit that lets a rehearsal publish, or that stops a tag push from
publishing, fails a gate.

### The local re-execution

`scripts/release-rehearsal.mjs` reads `release.yml`, resolves the `${{ … }}` expressions the
runner would resolve, and executes the job's own `run:` bodies in order under Node 22.19.0.
It executes the workflow's text rather than a hand-copied transcript of it. Steps that are
GitHub actions have no local equivalent and are reported as skipped with what satisfies
them locally.

Its workflow reader was cross-checked against `yaml@2.9.0`: for `release.yml`, the parsed
`on`, job `env`, and the full `steps` array are structurally identical to the reference
parser's output. It also reads scalar flow sequences such as CI's `branches: [main]` and
rejects unsupported nested flow collections rather than silently treating them as strings.
Both workflow files parse cleanly under the reference parser.

```sh
node scripts/release-rehearsal.mjs \
  --tag v0.1.0 \
  --node "$HOME/.nvm/versions/node/v22.19.0/bin" \
  --runner-temp /tmp/c3-rehearsal \
  --skip "Initialize colocated jj repository" \
  --skip "Typecheck all workspaces" --skip "Test all workspaces" --skip "Lint all workspaces" \
  --keep-going \
  --transcript /tmp/c3-rehearsal-release.json
```

`v0.1.0` is the tag that matches the manifests in this tree, so the validation gate runs
its passing path. The three skipped gates and the jj step are explained below.

| # | Step | Result |
|---|------|--------|
| 1 | `actions/checkout@v4` | skipped — action; locally this checkout is the tree under test |
| 2 | `pnpm/action-setup@v6` | skipped — action; pnpm 11.21.0 on PATH |
| 3 | `actions/setup-node@v4` | skipped — action; Node 22.19.0 pinned onto PATH |
| 4 | (unnamed) `pnpm install --frozen-lockfile --ignore-scripts` | **passed**, 4s |
| 5 | `Install jj` | skipped — action; jj on PATH |
| 6 | `Initialize colocated jj repository` | skipped — jj refuses inside a Git worktree |
| 7 | `Validate release tag` | **passed**, 8s |
| 8 | `Typecheck all workspaces` | skipped — see below |
| 9 | `Test all workspaces` | skipped — see below |
| 10 | `Lint all workspaces` | skipped — see below |
| 11 | `Circular-dependency guard` | **passed**, 140s |
| 12 | `Browser bundle guard` | **passed**, 27s |
| 13 | `Release manifest unit test` | **passed**, 1s |
| 14 | `Release rehearsal unit test` | **passed**, 1s |
| 15 | `Release version coherence` | **passed**, 1s |
| 16 | `Disaster-recovery script test` | **passed**, 12s |
| 17 | `Build all workspaces from clean artifacts` | **passed**, 444s — superseding revalidation at `/tmp/flows-c3-release-followup.c82b4Q/transcript.json`; this replaces the earlier 517s `apps/ui` timeout |
| 18 | `Pack and smoke-test release artifacts` | **passed**, 844s |
| 19 | `Compute the publish plan` | **passed**, 1s |
| 20 | `Publish packages in dependency order` | **skipped by its own `if: env.DRY_RUN != 'true'`** |
| 21 | `Report the skipped publication` | **passed** |

Resolved job environment for the run:

```
RELEASE_TAG=v0.1.0  DRY_RUN=true  PUBLISH_VERSION=0.1.0  PUBLISH_DIST_TAG=latest
```

Step 21 printed:

```
Dry run: every gate, the pack, and the smoke test ran. Nothing was published.
A real run would publish these at 0.1.0 on the latest dist-tag:
@smthrs/canonical-next smthrs-canonical-next-0.1.0.tgz
… 23 lines, the packed order …
```

**Superseded build timeout.** An earlier transcript recorded `apps/ui` timing out after
517s while loading `apps/ui/vite.config.ts`; the full revalidation transcript named in
the table records the same build passing in 444s. Every engine package did build —
`pack-release.mjs` refuses to pack a workspace whose `dist/esm`, `dist/cjs`, and `.d.ts`
outputs are not all present for every source file, and step 18 packed all 23.

### Targeted runs

Two further runs exercised the paths the main run could not reach from a `0.1.0` tree.

**The prerelease tag is refused until the manifests move.** With the tree at `0.1.0`:

```sh
node scripts/release-rehearsal.mjs --tag v0.1.0-next.0 --only "Validate release tag"
```

```
packages/artifacts/package.json has version 0.1.0; expected 0.1.0-next.0.
--- failed: Validate release tag (exit 1, 1s)
```

This is the gate working. It is why step 1 of the [runbook](release-runbook.md) is a
version bump, and `scripts/set-release-version.mjs` performs it across all 45 manifests
including the exact internal ranges.

**A prerelease publishes to `next`, and publication is skipped by the workflow, not by the
driver.** Reusing the pack the main run produced:

```sh
node scripts/release-rehearsal.mjs --tag v0.1.0-next.0 --runner-temp /tmp/c3-rehearsal \
  --only "Compute the publish plan" --only "Publish packages" --only "Report the skipped publication"
```

```
=== RUNNING: Compute the publish plan
Publish plan for 0.1.0-next.0 on the next dist-tag:
--- passed: Compute the publish plan (exit 0, 0s)
=== SKIPPED: Publish packages in dependency order (if: env.DRY_RUN != 'true')
=== RUNNING: Report the skipped publication
A real run would publish these at 0.1.0-next.0 on the next dist-tag:
```

### What this rehearsal could not prove

**No GitHub run.** A `workflow_dispatch` run was not triggered. GitHub only offers a
dispatch for a workflow that already exists **on the default branch**, and `main` carries
the pre-change `release.yml` with no dispatch trigger. The dry run becomes available on
GitHub the moment this branch lands; the runbook records the command. Nothing was pushed
to `origin` for this rehearsal.

**Three gates not re-executed:** `pnpm run check`, `pnpm test`, and `pnpm run lint`. This
change touches only `scripts/`, `.github/workflows/`, and `docs/` — no package source — so
those three gates cannot be affected by it, and `ci.yml` runs all three on a dedicated
runner for every pull request. They were skipped here because this machine was running
eight concurrent lane worktrees at load average 60–134, where the heavy suites' finite
per-test budgets fail on contention rather than on defects (the standing A5 finding). A
first attempt did start `pnpm run check` under that load and was stopped 25 minutes in
with 18 of 45 workspaces done.

**`jj git init --colocate` was skipped**: `jj` refuses to create a colocated repository
inside a Git worktree ("Cannot create a colocated jj repo inside a Git worktree"), and the
rehearsal ran in one. A GitHub runner checks out a plain repository, where the step is the
one CI already runs on every pull request.

The GitHub-hosted steps (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`,
`taiki-e/install-action`) were not executed; they are unchanged and CI runs the same
actions on every pull request.

## 5. Preconditions still open before a real publish

These are not rehearsal failures. They are the owner-side facts a publish needs, and each
is a step in the [runbook](release-runbook.md).

1. **The tree is at `0.1.0`, not `0.1.0-next.0`.** `Validate release tag` refuses a tag
   whose version does not match every engine manifest, and the engine packages depend on
   each other by exact version, so both must move together.
   `scripts/set-release-version.mjs` does that in one pass; `--check` verifies it.
2. **npm org control and name reservation for `@smthrs`** (`REVIEW.md` blocker 9).
3. **`LICENSE` copyright holder confirmation** (`REVIEW.md` blocker 5 caveat).
4. **The `npm-publish` GitHub environment** must carry a credential; `--provenance`
   expects npm trusted publishing configured for this repository and workflow.
