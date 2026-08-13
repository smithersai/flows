# Release-readiness review: `flows`

**Review date:** 2026-08-05 (America/Los_Angeles)  
**Repository:** `github.com/smithersai/flows`, commit `4e5ca54` on `main`  
**Scope:** 11 npm workspaces under `packages/*`; source, tests, docs, package artifacts, CI, and selected prior art  
**Verdict:** ~~**NOT YET**~~ → **READY AFTER** three owner-side confirmations: `@smthrs` npm-org control with all 11 names reserved, the `LICENSE` copyright holder, and one rehearsal of the never-executed release workflow against a prerelease tag. All nine code-level release blockers are closed at `cf6f831` — see [Blocker remediation](#blocker-remediation-post-review-run).

## Executive assessment

`flows` contains a serious, unusually well-tested durability core, but today's tree is not publishable and is not yet honest to position beside Temporal, Restate, or Inngest as a release-ready durable-execution library. The strongest engineering is real: the code has exact-snapshot run claims, owner-fenced attempt writes, heartbeat-based takeover, persisted retry origins, content-environment key material, transactional cycle detection, typed durable primitives, and 1,804 passing test assertions. The documentation is also much more candid and technically useful than most pre-release libraries: it explicitly names the non-atomic logical-WAL gap and separates implemented contracts from planned integration (`docs/architecture/implementation-status.md:32-59`).

The blockers are not polish. A clean `npm ci` fails before CI can run; the root tests and lint are red and `host`'s suite is additionally flaky (fixed 5-second timeouts around `jj` subprocess and streaming tests); `@smthrs/flows-next` **and** `@smthrs/host` claim ESM and declaration files that their successful builds do not create (shared root cause: `noEmit: true` in both main tsconfigs); `@smthrs/time-travel-next` would publish source exports rather than its built dual-module surface; no packed package contains a license file; the root license attributes the repository to the author of `pi` while the engine is demonstrably derived from Effect; the umbrella and host root entries do not browser-bundle; and the executable state transition and lifecycle journal entry remain separate transactions. Those findings are verified by commands and source below.

## Blocker remediation (post-review run)

**Added:** 2026-08-06 · **Head reviewed:** `cf6f831` on `main` (30 commits after the review's `4e5ca54`) · **Method:** read the git log, sampled the diffs of the highest-risk changes (WAL atomicity, exports maps, licensing, browser gate, release pipeline) against the head tree, and independently re-ran `packages/engine-store/test/WalAtomicity.test.ts` (6/6 pass, 17.7s). The four gates plus builds, packs, and the browser gate were re-run green immediately before this section was written; those results are reported, not re-derived. Everything below is verified against the head tree unless marked otherwise.

> **Working-tree note.** The run handed off with the tree clean apart from `REVIEW.md`, and it was clean when this pass started. At 00:12–00:13 on 2026-08-06, while this pass was running, another process wrote 15 further uncommitted files: `testTimeout`/`hookTimeout` of `30_000` added to all 11 `vitest.config.ts` files, and the `{ timeout: 0 }` overrides removed from `packages/host/test/NodeJj.test.ts`, `BrowserFileSystem.test.ts`, `sync/test/ServerSoak.test.ts`, and `engine-store/test/VerifiedDigestMemoBound.test.ts` — a second pass at blocker 6 that swaps infinite per-suite timeouts for a finite package-wide budget, so a genuine hang still fails the gate. The direction is right, but **those edits are uncommitted and ungated**; every status and gate result in this section is against `cf6f831`, not against them.

**Bottom line:** all nine release blockers from §"Release blockers" are closed in code. What remains is not code: two decisions only the owner can make (npm-org control, copyright holder) and one process that has never executed (the release workflow). The `NOT YET` verdict no longer describes this tree.

### Blocker status

| # | Blocker | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Lifecycle history atomic with executable state (WAL) | **Fixed** at `d18d27b` + `d0b9449` (docs `9db0b15`, `e86c700`) | `Journal.transact` runs a state projection and its `emitDurable` appends in one `Database.write`; store writes join as savepoints. Publication (PubSub + the in-process source-event index) is parked on a fiber-scoped settlement list and replayed only after COMMIT, so a rolled-back append is never visible and never poisons producer dedup — the subtle half, and it is handled. Eight pairs closed (attempt admission, pre-image patch, `attempts.finish`, cache provenance, run-row CAS, cancel, deferred completion, clock row). Scope discipline held: flow bodies, Jj snapshots, boundary prepare/settle, and the lossy `flush` stay outside the transaction. `packages/engine-store/test/WalAtomicity.test.ts` drives crash injection at every closed interstitial over the full SQL stack and asserts journal/state equivalence after restart — **re-run independently for this section: 6/6 pass**. `implementation-status.md:28` now states the invariant instead of the blocker, including the deliberate trade (a crash before COMMIT loses the whole unit, so an already-executed attempt re-executes on adoption — the same trade Temporal makes). |
| 2 | Repair and reproduce the lockfile | **Fixed** at `3ae6c53` | `npm ci --ignore-scripts` installs 477 packages and exits zero; the `packages/plugin` workspace record is present. CI's first step is no longer a wall. |
| 3 | Make every promised artifact exist | **Fixed** at `3b4bc66` | `noEmit: true` removed from `packages/flows/tsconfig.json` and `packages/host/tsconfig.json`; both compilerOptions are now aligned with the working `keys` sibling. Clean builds of flows, host, time-travel, keys, and engine each emit `dist/esm/index.js`, `dist/esm/index.d.ts`, and `dist/cjs/index.js`. The flows pack now carries 12 files including the ESM half and declarations (it was 6, CJS-only). CI and the release workflow both delete every `dist` and rebuild, so the false pass cannot return silently. |
| 4 | `@smthrs/time-travel-next` publish exports | **Fixed** at `bdcce1f` | `publishConfig.exports` now carries the same conditional dist map and `./internal/*`/`./*/index` null blocks as its siblings; the build script and tsconfig were fixed in the same commit so the map names artifacts that exist. Pack: 103 files with `dist/esm` and `dist/cjs`. |
| 5 | Authorship, upstream attribution, licenses in tarballs | **Fixed with a caveat** at `6540ca6` | `LICENSE:3` now reads `Copyright (c) 2026 William Cory and the Smithers Flows contributors`; the Mario Zechner line is gone. `packages/engine/THIRD_PARTY_NOTICES.md` reproduces Effect's MIT notice verbatim (`Copyright (c) 2023 Effectful Technologies Inc`) and cites `VENDOR.md`, which gained a Licensing section — this is the review's own stated alternative to a root `NOTICE.md`, and it discharges the obligation for the only vendored package. Every package now ships a byte-identical `LICENSE` in its `files` whitelist; every pack inspected contains it. **Caveat:** §3 required the copyright holder to be *confirmed by the owner*; the run chose a holder string without that confirmation. If the entity is Smithers AI rather than an individual, this is a one-line change — but it is an owner decision, not a fixed finding. |
| 6 | All mandated gates green, including the flaky ones | **Fixed** at `05f4cec`, `f5e4be4`, `c0d2c5e`, `7268cb1` (coverage/lint) and `8eae3fa`, `c57e5b5`, `86153a8` (determinism) | `npm run check`, `npm run lint`, and `npm run circular` all exit zero. `npm test`: 23 files, 226 passed / 1 skipped, statements 617/617 and branches 262/262 at 100%. The three wall-clock-sensitive suites the review caught (`host` streaming and `jj` subprocess timeouts, `engine-store` memo stress, `sync` subscriber soaks) were decoupled from wall time rather than having their thresholds lowered — the review's explicit condition. |
| 7 | Honor or narrow the browser contract | **Fixed — narrowed and gated** at `d65c909`, `2707cba`, `3f62547`, `08e647d`, `5f16f56`, `cf6f831` | Platform and test layers moved off the browser entry points, and `scripts/browser-check.mjs` now executes the contract in CI: 10 entry points MUST bundle under `--platform=browser` (host root, `BrowserHost`, kernel, keys, database, journal, engine, plugin, sync, time-travel) and 6 documented Node-only entries MUST still fail, *and fail only for the documented `node:` reason* — so a Node import can neither creep into a browser entry point nor silently vanish from a Node-only one. Gate output at head: "browser contract holds: 10 browser entry points, 6 Node-only. Failures: none." **Deliberate residue, per §2:** the umbrella `@smthrs/flows-next` root and `@smthrs/engine-store-next` remain Node-only (`node:crypto`, `process.pid`); browser consumers import per-package roots. The `/node`, `/bun`, `/browser` subpath restructure is still deferred to 0.2.0, exactly as the judgment pass decided. |
| 8 | Release pipeline compatible with provenance | **Fixed in repo, unproven in practice** at `a6801ec` | `.github/workflows/release.yml` fires on `v*` tags with `id-token: write`, a protected `npm-publish` environment, `npm ci`, all four gates, a clean-`dist` rebuild, tag→version validation across all 11 manifests, topological `npm publish --provenance`, and a post-publish job that installs the barrel from the registry and loads it over both `import()` and `require()`. That is the standard recipe and it is complete. **Caveat:** it has never run. Whether npm-side trusted publishing is configured for the `@smthrs` scope is not observable from this repository. |
| 9 | Names, versions, and internal ranges | **Fixed mechanically; the decision half is open** at `78640a3` | All 11 manifests are exactly `0.1.0`, every internal production range is exact `0.1.0`, and `effect` is pinned exact `4.0.0-beta.102`. Package names were kept, which is the judgment pass's decision (§4), not an omission. **Two things did not land:** (a) `@smthrs` org control and name reservation are external facts the run could not verify or effect; (b) §4 recommended holding `@smthrs/plugin` back as `private` and dropping it from the barrel and its dependency list until plugin dispatch is wired — instead it is public `0.1.0`, still a `@smthrs/flows-next` dependency, still in the barrel, and has its own line in the publish job. That sells an extension API nothing calls. It is a one-commit reversal if the owner agrees with §4. |

### High-priority items that also landed

Not blockers, but they came with the run: the three missing changelogs with 0.1.0 sections (`2bd1d6a`), `CONTRIBUTING.md` and `SECURITY.md` (`012d330`), removal of the recursive `flows` self-symlink and the stale `@earendil-works/pi-*` aliases from the root tsconfig (`da27615`), and browser/build/pack gates added to CI (`2707cba` and the release workflow).

### Remaining — verbatim, nothing folded

**Owner decisions and unproven process (these are what stand between this tree and `npm publish`):**

1. Verify control of the `@smthrs` npm organization and reserve all 11 names. The review's E404s proved availability to that client, not ownership; nothing in the run changed that.
2. Confirm the `LICENSE` copyright holder. The run wrote `William Cory and the Smithers Flows contributors` without the owner confirmation §3 required.
3. Rehearse `.github/workflows/release.yml` against a prerelease/`next` tag before tagging `v0.1.0`. It has never executed, and npm-side trusted-publishing configuration is not verifiable from the repo.
4. ~~Decide `@smthrs/plugin`: §4 said hold it back (`private`, out of the barrel and the dependency list); the run published it. Either reverse it or record the disagreement.~~ **Settled by deletion.** The package was removed entirely — no runtime ever dispatched one of its hooks, and its only consumer was the barrel re-export. Extension in `flows` is Effect dependency injection at the seam that owns the behavior, recorded as D11 in [design decisions](docs/architecture/design-decisions.md). The remaining `@smthrs/plugin` references below are historical, describing the tree as reviewed.

**High-priority items from the original review that are still open, unchanged:**

5. No packaged production SQLite layer and no crash/restart getting-started example. `docs/guides/getting-started.md:30` still composes `FlowEngine.layerMemory`, so a reader still cannot reach a durable flow from the guide — the review's "required newcomer artifact" does not exist.
6. Missing content-environment configuration is still silently an empty environment (`packages/engine/src/Activity.ts:375` defaults to `{ layers: [], capabilities: {} }`), so undeclared remains indistinguishable from proven-pure and stale cross-run cache reuse after a host/model change is still possible.
7. Three status/doc contradictions the review flagged are still in the tree: `implementation-status.md:12` still says heartbeat write tolerance is "two ticks shorter than the steal cutoff" (it is 19s versus 30s — eleven ticks); `implementation-status.md:19` still claims "Host bundles — Node, Bun, browser/test, Cloudflare, Vercel Edge, and Vercel Node adapters" for a repo whose 11 packages contain no such adapters; and `docs/concepts/step-keys.md` still says a content key "does not change merely because an activity's display name changes" while string keys fold the activity name.
8. Docs are not yet standalone: 22 `docs/specs` links in package READMEs still escape into the parent-only vault, `docs/README.md:40-41` still links `guides/cloudflare.md` and `guides/vercel.md` which do not exist, and both `README.md:3` and `docs/README.md:3` still describe the library as "unreleased" — that last one will be false the moment it publishes.
9. `CODE_OF_CONDUCT.md`, issue templates, and a pull-request template are still missing (CONTRIBUTING and SECURITY landed).
10. Public API rationalization did not happen: `namespaces` is still exported from the barrel purely to give coverage a denominator (`packages/flows/src/index.ts:51`), and the `@since`/`@category` inconsistencies in the entrypoints are unchanged.
11. `@smthrs/host`'s `./test/contract` is still a raw `./test/contract/HostContract.ts` export under `publishConfig`, the only non-emitted public subpath in the tree.
12. CI is still Ubuntu-only and `node-version: 22` with no matrix — no exact-minimum 22.19.0, no current Node, no macOS/Windows, no Bun. The browser, build, and pack gates were added; the platform matrix was not.

None of items 5–12 blocks `npm publish` on the review's own ranking; items 7 and 8 do mean the published docs would ship known-false statements, which is worth an hour before announcing.

## Final judgment (adversarial pass)

**Review date:** 2026-08-05 · **Pass:** third (kimi K3), judgment layer over the two verified passes. The contested seams were re-read first-hand — `ActivityPersistence.ts:920-985`, `RunDriver.ts:573-593`, the `implementation-status.md` crash-consistency blocker, `VENDOR.md`, `LICENSE`, engine source headers, and all 11 manifests; the gates were not re-run. Where I disagree with the prior passes, it is stated explicitly.

### 1. The verdict framing, attacked

The prior passes offer two postures — fix the logical-WAL gap, or downgrade to an "experimental research preview" — and call the gap disqualifying. The framing is too narrow and the premise is overstated. I confirmed the order in source: `attempts.finish` commits, then `attemptFinished` emits (`ActivityPersistence.ts:920-985`); `transitionOwned` commits, then the decision emits (`RunDriver.ts:573-593`). The store rows are authoritative and self-consistent; nothing executable is journal-derived. A crash in the gap leaves the journal **incomplete**, never execution **incorrect**. This is an observability-completeness defect, not an execution-correctness one, so a third posture the review did not offer is technically available: ship 0.1.0 with the journal documented as a best-effort audit channel and time travel/sync marked non-authoritative.

I considered that posture and reject it — not because the library would be unsafe, but because time travel and journal-backed sync are two of the four differentiators this library is launched on (§8), and shipping them with a documented hole invites the first public reviewer to re-litigate this exact finding against the launch. The fix is also cheap relative to the rest of the punch list: two interstitial seams whose event writer (`SqlJournal.emitDurable`, `SqlJournal.ts:881-951`) is already internally transactional, so the work is widening a transaction boundary, not inventing one. **Posture I would take: a full `0.1.0` — not a prerelease, not an "experimental preview" — with WAL atomicity fixed before publish.** I explicitly disagree with pass 1's "disqualifying" wording: the gap is disqualifying for the *marketing claim* "journal as account of record," not for a 0.x release of the durable core with honest docs. It becomes disqualifying by judgment only because the honest alternative wastes the launch.

### 2. Blockers ranked by real risk

Rank is by damage at publish time, not by category. Effort: S < 1 day, M = days, L = weeks.

| # | Blocker | Real risk | Effort |
| --- | --- | --- | --- |
| 1 | Lockfile / `npm ci` | Gates everything: CI is dead, so no other fix is verifiable and publish is a leap of faith. | S |
| 2 | `noEmit` builds (flows, host) | The two packages a consumer installs first ship broken tarballs; umbrella ESM simply fails. | S (+M for a pack/artifact gate that keeps it fixed) |
| 3 | Licensing/attribution | Legal misattribution plus a missing required upstream notice in substantial copies; trivial to fix, impossible to excuse. | S |
| 4 | Naming/version lockstep | Decision-gated and hard to walk back: wrong internal ranges (`*`, exact `0.0.0`) rot every install the moment anything moves. | S (mechanical; the decision is the work) |
| 5 | Gates green incl. flaky host | You cannot launch a "well-tested" library with red gates; the host flakes mean the suite currently measures machine speed, not correctness. | S for lint/coverage; M for deterministic timing tests |
| 6 | WAL atomicity | The only design-level item; reputation risk if shipped open, and cheap to close (§1). | M |
| 7 | `@smthrs/time-travel-next` publish exports | Would publish raw `src/*.ts`; broken for consumers, one manifest stanza to fix. | S |
| 8 | OIDC trusted publishing | `provenance: true` in every manifest means publishing from a laptop errors; no pipeline, no provenance story. Standard recipe. | M |
| 9 | Browser contract | Nothing breaks at publish if the claim is narrowed; the failure today is that docs promise what entrypoints do not deliver. | S to narrow (docs); M–L to honor in code |

**Deliberately NOT fixed in code for v0.1.0:** the browser split (item 9). Narrow the documented promise to "browser-safe host contracts exist — `BrowserHost` bundles; the durable engine is Node/SQLite-first" and defer the `/node`, `/bun`, `/browser` subpath restructure to 0.2.0. Everything else on the blocker list ships fixed; a v0.1.0 with any of items 1–8 open is not worth publishing.

### 3. Licensing determination, sanity-checked

The prior determination is correct and I confirm it from source: `LICENSE:3` credits Mario Zechner, no sampled engine source file carries any copyright header, and `VENDOR.md:3-19` documents an Effect fork at `23e176a…` / `effect@4.0.0-beta.102` across nine modules. Ship exactly this arrangement:

1. **Root `LICENSE`:** MIT, one copyright line — `Copyright (c) 2026 <owner>`, where `<owner>` is the legal entity the owner confirms (Smithers AI if an entity exists, otherwise William Cory). Delete the Mario Zechner line entirely; nothing in the 11 packages is pi-derived.
2. **Root `NOTICE.md`:** states that `packages/engine` contains code derived from Effect (`Effect-TS/effect`), `Copyright (c) 2023 Effectful Technologies Inc`, used under the MIT license, with the full upstream MIT text reproduced and a pointer to `packages/engine/VENDOR.md` for the fork point.
3. **Every tarball** contains `LICENSE` (the corrected root file, added to each `files` whitelist). **`@smthrs/engine-next`'s tarball additionally contains `NOTICE.md`** with the Effect notice, and `VENDOR.md` gains a line naming the upstream license (MIT, Effectful Technologies Inc). No per-file headers are required: MIT obligates preserving the notice with substantial copies, and `NOTICE.md` + `VENDOR.md` discharges that for the engine, the only vendored package.

### 4. Naming and package decisions, final

- **Scope and names:** publish under `@smthrs` (verify org control and reserve every name the day the decision lands; the prior pass's E404s prove availability to this client, not ownership). Product: **Smithers Flows**; primary package **`@smthrs/flows-next`**. I disagree with pass 1's recommendation to rename generic leaves to `@smthrs/flows-*`: the packages ship either way so the renames buy nothing at publish time, the scope prefix already disambiguates, and the churn across imports, the barrel, and docs is real. Keep all existing names.
- **Publish 10 of 11 packages at v0.1.0. Hold `@smthrs/plugin` back** (mark `private`, drop it from the barrel and its dependency list): its kernel is green, but the engine call sites that would invoke its hooks are explicitly unwired (`implementation-status.md`, planned integration), so publishing it now sells an extension API nothing calls. Ship it in 0.2.0 when plugin dispatch lands. `database`, `keys`, `journal`, and `kernel` must publish despite being implementation-flavored — they are runtime dependencies of published packages; label them low-churn implementation packages in their READMEs rather than trying to hide them. Publish `sync` and `time-travel` alongside the rest; under the §1 posture the WAL fix lands before publish, so they ship authoritative.
- **Version line:** every published package at exactly `0.1.0`, internal ranges exact `0.1.0` in published manifests, `effect` pinned exact `4.0.0-beta.102`. Lockstep until 1.0.

### 5. The verdict paragraph

flows today is a genuinely well-engineered durable-execution core — exact-snapshot run claims, owner-fenced attempt writes, heartbeat takeover, transactional cycle detection, retry budgets that survive process death, and 1,804 passing assertions — trapped inside packaging that does not yet tell the truth the code does: a lockfile CI cannot install, two flagship packages whose builds emit half their promised surface, a license that credits the wrong author and omits the required Effect notice, and a journal that cannot fully account for state it never claimed to own. Before `npm publish` it must regenerate the lockfile, make the flows/host/time-travel builds emit what their manifests promise, correct authorship and ship licenses in every tarball, normalize to lockstep 0.1.0 with exact internal ranges, turn all four gates green including the flaky host suite, close the two-transaction WAL gap, stand up OIDC trusted publishing, and narrow the browser claim to what actually bundles. Every one of those except the WAL fix is mechanical and days-scale, and the WAL fix is two seams whose writer is already transactional. It is roughly two to three focused weeks from worthy — close — and nothing on the list requires new architecture, only the discipline to make the repo, the tarballs, and the license as honest as the implementation already is.

## Evidence conventions

- **Verified — command:** observed by executing the named command in this checkout.
- **Verified — source:** read in the cited file and line range.
- **Inferred:** a conclusion drawn from cited evidence; the inference is named explicitly.
- Command timings are `/usr/bin/time -p` wall times. Commands ran on Node `v26.5.0`, npm `11.17.0`. Every workspace manifest requests TypeScript `6.0.3`; the lockfile has no `packages/plugin` workspace record at all, resolves per-workspace TypeScript `6.0.3` only for the ten locked workspaces, and pins the root-hoisted `node_modules/typescript` to `5.9.3` (`package-lock.json:7985-7990`; representative manifest `packages/engine/package.json:82-96`). A clean install fails, so the local script results are not reproducible from the committed lockfile. Gate outcomes were re-verified on a second pass (check PASS, test FAIL, lint FAIL, circular PASS, `npm ci` FAIL); wall times varied with machine load and are noted where re-measured.

## 1. Does the machine work?

### Root gates

| Command | Wall time | Result | Package detail |
| --- | ---: | --- | --- |
| `npm run check` | 68.61s (78.06s re-run) | **PASS** | All 11 workspace `tsc` invocations exited zero. |
| `npm test` | 95.02s | **FAIL** | All assertions passed in the first run (205 files; one host test skipped), but `engine-store` and `sync` failed their enforced 100% coverage thresholds. Re-runs were worse: `host` also failed its 100% branch gate (99.61%) under concurrency, and `host` unit tests flaked with 2–3 timing-sensitive failures when run alone (details below). |
| `npm run lint` | 65.41s | **FAIL** | `engine-store` has one dprint failure; `sync` has one ESLint error. The other nine workspaces passed. Reproduced verbatim on re-run. |
| `npm run circular` | 15.38s (119.92s and 157.80s re-runs) | **PASS** | All 11 `scripts/circular.mjs` invocations exited zero; the re-run wall times are inflated by concurrent load on this machine (user time stayed ~14s), not by the tool. |
| `npm ci --ignore-scripts` | 0.99s before rejection | **FAIL** | The lock is missing `@smthrs/plugin@0.0.0` (twice) and `typescript@6.0.3`. CI runs `npm ci` first (`.github/workflows/ci.yml:18`), so current CI cannot reach its gates. Reproduced verbatim on re-run; node_modules is untouched because npm rejects before installing. |

**Verified — command, exact clean-install failure:**

```text
npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: @smthrs/plugin@0.0.0 from lock file
npm error Missing: @smthrs/plugin@0.0.0 from lock file
npm error Missing: typescript@6.0.3 from lock file
```

The lock contains only ten top-level workspace records and omits `packages/plugin`; `jq` enumerated `packages/database` through `packages/time-travel` without `packages/plugin`. `npm ls --all --json` also exited `ELSPROBLEMS`, reporting installed `typescript@5.9.3` invalid against the manifests. `npm install --package-lock-only --ignore-scripts --dry-run` misleadingly printed “up to date”; `npm ci` is the release-relevant proof.

### Per-package typecheck, tests, lint, and circular result

| Package | `check` | Tests | Coverage gate | `lint` | `circular` |
| --- | --- | ---: | --- | --- | --- |
| `@smthrs/database-next` | PASS | 4 files / 29 passed | 100% | PASS | PASS |
| `@smthrs/engine-next` | PASS | 26 / 234 passed | 100% | PASS | PASS |
| `@smthrs/engine-store-next` | PASS | 60 / 332 passed | **FAIL** | **FAIL** | PASS |
| `@smthrs/flows-next` | PASS | 2 / 63 passed | 100% | PASS | PASS |
| `@smthrs/host` | PASS | 23 / 225 passed, 1 skipped (first run); **flaky on re-runs** | **FAIL (flaky)** | PASS | PASS |
| `@smthrs/journal-next` | PASS | 17 / 198 passed | 100% | PASS | PASS |
| `@smthrs/kernel-next` | PASS | 23 / 309 passed | 100% | PASS | PASS |
| `@smthrs/keys-next` | PASS | 4 / 41 passed | 100% | PASS | PASS |
| `@smthrs/plugin` | PASS | 6 / 49 passed | 100% | PASS | PASS |
| `@smthrs/sync-next` | PASS | 20 / 113 passed | **FAIL** | **FAIL** | PASS |
| `@smthrs/time-travel-next` | PASS | 20 / 211 passed | 100% | PASS | PASS |

**Verified — command, host flakiness on re-run (new finding, this machine):** running the full suite concurrently with lint/circular made `host` fail its branch gate at 99.61% (261/262); running `npm test -w @smthrs/host` alone then failed 2–3 tests per attempt with fixed 5,000ms timeouts — `test/BrowserFileSystem.test.ts:6` "streams bounded chunks without loading the complete file" (21,332ms in one run) and `test/NodeJj.test.ts:58` jj snapshot tests (5,105ms, 6,368ms). The failing set varied run to run with jj 0.39.0 installed (the same version CI pins). A 100%-of-branches gate plus wall-clock-timeout tests that spawn `jj` or stream 200k chunks is nondeterministic on a loaded or slow machine; the suite cannot currently distinguish "code is correct" from "machine was fast enough."

**Verified — command, exact red test output:**

```text
@smthrs/engine-store-next
Statements   : 99.82% ( 1115/1117 )
Branches     : 99.68% ( 632/634 )
Functions    : 100% ( 302/302 )
Lines        : 99.9% ( 1040/1041 )
ERROR: Coverage for lines (99.9%) does not meet global threshold (100%)
ERROR: Coverage for statements (99.82%) does not meet global threshold (100%)
ERROR: Coverage for branches (99.68%) does not meet global threshold (100%)

@smthrs/sync-next
Statements   : 100% ( 494/494 )
Branches     : 98.88% ( 177/179 )
Functions    : 100% ( 172/172 )
Lines        : 100% ( 441/441 )
ERROR: Coverage for branches (98.88%) does not meet global threshold (100%)
```

The thresholds are intentionally active on every run (`packages/engine-store/vitest.config.ts:8-30`, `packages/sync/vitest.config.ts:8-28`), so these are real gate failures, not cosmetic coverage reports.

**Verified — command, exact red lint output:**

```text
packages/engine-store/test/ReplayCorruptionClassification.test.ts
Found 1 not formatted file. Run dprint fmt to fix.

packages/sync/src/BranchServer.ts
14:1  error  All imports in the declaration are only used as types. Use `import type`
@typescript-eslint/consistent-type-imports
```

### Build and artifact verification

Representative package builds were run directly through their workspace scripts:

| Package | Wall time | Script exit | Promised ESM | Promised CJS | Declarations | Import/require smoke |
| --- | ---: | --- | --- | --- | --- | --- |
| `@smthrs/keys-next` | 6.95s | PASS | present | present | present | both PASS |
| `@smthrs/engine-next` | 5.26s | PASS | present | present | present | both PASS |
| `@smthrs/flows-next` | 7.96s | **false PASS** | **missing** | present | **missing** | ESM fails `ERR_MODULE_NOT_FOUND`; CJS loads |
| `@smthrs/host` | — | **false PASS** | **missing** | present | **missing** | not smoke-tested (same defect as flows) |

`packages/flows/tsconfig.json:18` and `packages/host/tsconfig.json:18` both set `noEmit: true` — the only two main tsconfigs in the repo that do (all other `noEmit` occurrences are in `tsconfig.test.json` files, where it is correct). Meanwhile `packages/flows/package.json:54-58` promises `dist/esm/index.d.ts`, `dist/esm/index.js`, and `dist/cjs/index.js`, and `packages/host/package.json` `publishConfig.exports` promises the same `dist/esm`/`dist/cjs` layout for `.` and `./*`. The build scripts are **not** the cause: `packages/flows/scripts/build.mjs:16-31` is the same tsc-plus-esbuild pattern as the working `packages/keys/scripts/build.mjs:17-47` and `packages/engine/scripts/build.mjs:17-47`; tsc simply emits nothing under `noEmit`, so only the esbuild CJS half ever appears. Deleting `packages/flows/dist` and rebuilding reproduced it: exit 0, `dist/` contains only `cjs/`; `@smthrs/host` behaves identically (exit 0, only `dist/cjs`). A dry-run pack of flows contained only `dist/cjs/index.js`, its map/package marker, `src/index.ts`, README, and package manifest—six entries total. This is a release blocker for both packages.

The keys and engine build scripts do produce `dist/esm` plus `dist/cjs`, including `dist/cjs/package.json` with `type: commonjs` (`packages/keys/scripts/build.mjs:17-47`, `packages/engine/scripts/build.mjs:17-47`). Both emitted entrypoints loaded successfully via native `import()` and `require()`.

## 2. Publishability audit

### Package/version/dependency matrix

| Package | Version | Internal production ranges |
| --- | ---: | --- |
| `@smthrs/database-next` | 0.0.0 | — |
| `@smthrs/engine-next` | 0.0.0 | `keys: *` |
| `@smthrs/engine-store-next` | 0.0.0 | `database`, `keys`, `engine`, `journal`, `kernel`: `*` |
| `@smthrs/flows-next` | 0.0.0 | exact `0.0.0`, except `kernel: 0.1.0` |
| `@smthrs/host` | 0.0.0 | — |
| `@smthrs/journal-next` | 0.0.0 | `database: *` |
| `@smthrs/kernel-next` | **0.1.0** | `host`, `journal`: `*` |
| `@smthrs/keys-next` | 0.0.0 | — |
| `@smthrs/plugin` | 0.0.0 | `engine: *` |
| `@smthrs/sync-next` | 0.0.0 | `journal: *` |
| `@smthrs/time-travel-next` | 0.0.0 | exact `0.0.0` for five packages |

**Verified — source:** versions and ranges are in `packages/*/package.json`; representative evidence is `packages/kernel/package.json:2-5,77-80`, `packages/engine-store/package.json:77-83`, `packages/flows/package.json:77-88`, and `packages/time-travel/package.json:62-68`.

The current mix is wrong for a coordinated first release. Exact `0.0.0` ranges will become stale when packages move to `0.1.0`; `*` admits any future breaking version and makes an old consumer install a potentially incompatible internal major. **Recommendation:** release all packages at `0.1.0` in lockstep and generate exact internal `0.1.0` dependencies in published manifests. Keep Effect pinned exactly while it remains beta.

### Manifest mechanics, all packages

- All packages declare `type: module`, Node `>=22.19.0`, `license: MIT`, `sideEffects: []`, public repository metadata, README, a `files` whitelist, and `publishConfig.access: public` plus `provenance: true` (representative shape: `packages/database/package.json:2-67`). **Verified — source.**
- Ten packages override development source exports with dual ESM/CJS publish exports and block `./internal/*` plus `./*/index` (`packages/database/package.json:32-67`). The more-specific null patterns are correctly shaped to win over `./*`. **Verified — source; inferred correctness from Node export-pattern specificity.**
- `@smthrs/time-travel-next` is the exception: its `publishConfig` contains only access/provenance (`packages/time-travel/package.json:49-52`), leaving public exports pointed at raw `src/*.ts` (`:32-37`) despite building `dist`. **Release blocker.**
- `@smthrs/host/test/contract` remains a raw TypeScript export even under `publishConfig` (`packages/host/package.json:35,47,61`). It should be emitted and conditionally exported like every other public subpath, or explicitly documented/tested as source-only under the minimum Node runtime. **High priority.**
- The whitelists include source and internal implementation files even though internal imports are blocked. That is not mechanically wrong, but it increases tarball size and publishes implementation detail. If source maps already contain `sourcesContent`, ship `dist`, README, changelog, license, and vendor notice only. **Nice to have.**

### README, changelog, license, and pack contents

- Every package has its own README (39–295 lines). This is a real strength because npm renders the package README. **Verified — file inventory.**
- `packages/flows/CHANGELOG.md`, `packages/plugin/CHANGELOG.md`, and `packages/sync/CHANGELOG.md` do not exist even though every corresponding whitelist names `CHANGELOG.md` (`packages/flows/package.json:39-47`, `packages/plugin/package.json:39-47`, `packages/sync/package.json:39-47`). npm silently omitted them in the flows dry-run pack. **Verified — file inventory and command.**
- `packages/engine/VENDOR.md` exists, is included, and gives an unusually precise Effect fork point and module list (`packages/engine/VENDOR.md:1-19`). That provenance record should be retained and expanded with licensing details.
- No package has a package-local `LICENSE`. Dry-run packs for keys (46 files), engine (82), and flows (6) contained no license file. An MIT string in `package.json` is not a substitute for including the notice required by the license. **Verified — command and file inventory.**
- `npm pack --dry-run --json` otherwise showed the keys and engine ESM/CJS artifacts and source files expected from their whitelists. The engine pack included `VENDOR.md`; the flows pack exposed the missing ESM/declarations and missing changelog. **Verified — command.**

## 3. Provenance and licensing

The current root license is incorrect for this standalone repository: it says `Copyright (c) 2025 Mario Zechner` (`LICENSE:1-4`). The repository's own parent instructions state that flows is “being written from scratch in Effect.ts” and “is not a port of pi” (`/Users/williamcory/flows/CLAUDE.md:1-5`), and say `pi` is reference code, not to be ported (`:17-19`). Git blame shows the Mario line arrived wholesale in extraction commit `1be826b`, rather than being established from a flows authorship audit. **Verified — source and git history.**

Conversely, `@smthrs/engine-next` is expressly derived from Effect. `VENDOR.md` names Effect-TS/effect commit `23e176a…`, package `effect@4.0.0-beta.102`, the upstream workflow source, and nine vendored modules (`packages/engine/VENDOR.md:3-19`). A no-index diff against the read-only Effect corpus found substantial common structure even after the fork: for example `DurableDeferred.ts` differs by 121 additions/105 deletions and `FlowEngine.ts` versus upstream `WorkflowEngine.ts` by 874/183. The upstream license is MIT, `Copyright (c) 2023 Effectful Technologies Inc`, and requires preservation of its copyright and permission notice (`/Users/williamcory/flows/reference/effect/LICENSE:1-13`). **Verified — source and command.**

**Required correction:**

1. Replace Mario Zechner's line unless an actual pi-derived file audit finds code that requires it. Nothing reviewed in the 11-package library establishes pi derivation; the checked-in design instruction establishes the opposite. This conclusion is **inferred** from the instructions, vendor record, and history—not a legal opinion.
2. Name the actual copyright holder for original flows code (the legal person/entity that owns it; likely William Cory or Smithers AI, to be confirmed by the owner).
3. Preserve Effectful Technologies Inc's MIT notice for the vendored engine, either in the root license plus a clear “portions” notice or in `THIRD_PARTY_NOTICES.md`/`packages/engine/LICENSE` shipped in the engine tarball.
4. Put the corrected license text in every published tarball. The barrel should also ship it because it is itself an npm distribution.

Until those actions are complete, publishing would misattribute original authorship and omit a required upstream notice from substantial copies. **Release blocker.**

## 4. Public API quality and newcomer path

### Surface quality

The basic Effect-style structure is strong. Most modules use namespace exports, Context services, `make`/`makeNoop`, and `layer`/`layerNoop`; almost every top-level declaration module has one `@since` and `@category` per exported declaration. Examples include `packages/database/src/Database.ts` and the journal/store modules. **Verified — source scan.**

The entrypoints are inconsistent with the repository's stated convention that every public export carries both tags:

- `packages/engine/src/index.ts:7-55` gives all ten namespaces `@since 4.0.0` but no `@category`. `4.0.0` is the upstream Effect version, not a possible version of this `0.1.0` package; keep upstream provenance in `VENDOR.md` and use package-local API versions.
- `packages/host/src/index.ts:10-23` has 12 public exports with no per-export tags.
- `packages/flows/src/index.ts:26-35` has ten namespace exports with no per-export tags.
- `packages/time-travel/src/index.ts:1-26` has `@since` on 13 namespaces and no `@category`.
- `packages/keys/src/index.ts:19-24` documents `KeyMaterial` but leaves `StepKey` without its own block.

The barrel's only original runtime value, `namespaces`, exists explicitly to give coverage a non-empty denominator (`packages/flows/src/index.ts:37-62`). That is test infrastructure exposed as permanent public API. Prefer an export-conformance test that does not manufacture a runtime API; otherwise document a real consumer use case. **High priority.**

Test and platform implementations are also mixed into root namespaces (`packages/host/src/index.ts:18-23`, `packages/journal/src/index.ts:73-83`, `packages/database/src/index.ts:12-22`). The most harmful instance is host: its root statically re-exports Node and Bun implementations (`packages/host/src/index.ts:19-20`), so a browser bundle resolves Node built-ins before tree-shaking. Keep the root contracts browser-safe and expose implementations under explicit `/node`, `/bun`, `/browser`, and `/test` subpaths, mirroring Effect's package split. **Release blocker if browser support remains a hard promise.**

### Browser verification

**Verified — command:** esbuild with `--bundle --platform=browser` failed on the umbrella with 131 resolution errors and on the host root with 129 (esbuild prints "6 of 131 errors shown" / "6 of 129 errors shown" under its default log limit; reproduced twice). Representative failures were `node:crypto` from `packages/engine-store/src/EngineStore.ts:20`, `node:child_process` from `packages/host/src/node/NodePty.ts:26` and `NodeJj.ts:17`, `node:sqlite` via `@effect/sql-sqlite-node`, and Node filesystem/http modules pulled through `@effect/platform-node`. In contrast, bundling `packages/host/src/browser/BrowserHost.ts` succeeded (~1.26 MB unminified bundle; 1,260,185 bytes measured).

Therefore the accurate claim today is **“a browser-capable host implementation exists”**, not “the library/barrel is browser compatible.” The durable engine store is explicitly Node-specific (`docs/architecture/implementation-status.md:61-70`).

### Getting-started walkthrough

I executed the first code block from `docs/guides/getting-started.md:18-41` against the workspace. It printed exactly `Hello, Ada.`. **Verified — command.**

The path still fails the requested newcomer test:

1. It says the repository is unreleased and instructs users to consume workspace/file dependencies (`docs/guides/getting-started.md:5-15`), so it is not an `npm install @smthrs/flows-next` path.
2. It imports `@smthrs/engine-next`, not the advertised umbrella (`:18-20`).
3. It intentionally uses `FlowEngine.layerMemory` and says it has no process-crash durability (`:3,27-31`). Thus a reader cannot reach a durable flow from this guide.
4. The second snippet uses `yield*` at top level (`:49-57`). `node --check --input-type=module` rejects it with `SyntaxError: Unexpected strict mode reserved word`. It needs a complete `Effect.gen` context.
5. The durable-engine guide supplies an integration-test composition (`docs/guides/durable-engine.md:15-46`) and then only prose assembly steps for persistent SQL (`:48-59`). It openly says the boundary, liveness, and Node identity remain application work (`:61-79`). There is no packaged production layer, also admitted in `implementation-status.md:48-53`.

**Required newcomer artifact:** one install command and one complete, copy-paste example importing `@smthrs/flows-next`, running migrations against a file-backed SQLite database, supplying a safe local-owner/liveness policy, executing an activity, killing/restarting the process, and observing replay without re-running the activity. Until that exists, the durable value proposition cannot be evaluated from npm.

## 5. Durability semantics spot-check

### Logical WAL versus authoritative state — release blocker

The repository deserves credit for naming this accurately. `implementation-status.md:42-44` says executable authority lives in run/attempt/cache/engine-state rows and that the lifecycle entry commits in a separate transaction. The code backs the admission:

- an attempt result is committed with `attempts.finish` and only afterward emitted as `attemptFinished` (`packages/engine-store/src/internal/ActivityPersistence.ts:920-985`);
- a run terminal/suspended transition commits with `transitionOwned` and only afterward emits `transitioned` (`packages/engine-store/src/internal/RunDriver.ts:573-593`);
- `emitDurable` itself correctly allocates and inserts its event within one journal transaction (`packages/journal/src/SqlJournal.ts:881-951`), but it cannot atomically cover the preceding store transaction.

A crash in either gap leaves replayable executable state that audit, sync, and time-travel cannot explain. Execution recovery may remain correct because the rows are authoritative, but a library that advertises journal-backed time travel and sync cannot treat the journal as an account of record with missing lifecycle facts. **Assessment:** disqualifying for the requested “worthy standalone durable-execution library” release. It could only ship before resolution as an explicitly experimental preview with time travel/sync/audit marked non-authoritative—not as a production durability peer.

Temporal's reference implementation provides the bar the docs invoke: it closes mutable state into a mutation plus event sequences (`reference/temporal/service/history/workflow/context.go:824-899`), submits both in one `UpdateWorkflowExecutionRequest` (`workflow/transaction_impl.go:167-200`), and stamps the persistence write with the shard `RangeID` fence (`service/history/shard/context_impl.go:640-654`). **Verified — reference source.** Flows' owner CAS is a useful local analogue to fencing, but the state/event atomicity claim is not at Temporal parity yet.

### Fencing and stale-owner takeover — substantially backed

- Claim/steal reads an exact snapshot, requires heartbeat staleness plus application liveness evidence, then activates with claim identity (`RunDriver.ts:207-287`).
- Heartbeats are one second, steal cutoff 30 seconds, skew allowance 10 seconds, and write-failure tolerance computes to **19 seconds** (`packages/journal/src/Ownership.ts:70-133`). The owner races work against the heartbeat loop and interrupts on lost fence or tolerance expiry (`:135-180`; `RunDriver.ts:476-492`).
- Attempt start/finish writes receive the owner fence (`ActivityPersistence.ts:813-850,896-985`), so a displaced writer cannot settle durable attempt state.

The self-declared status contains one inaccurate number: it says write tolerance is “two ticks shorter than the steal cutoff” (`implementation-status.md:12`). The current equation is 30s − 10s skew − 1s tick = 19s, **eleven** one-second ticks shorter. The safety direction is stronger than the prose, but the parity/status table must be corrected.

The source is also honest that wall-clock leases cannot prevent overlapping external side effects beyond the skew budget; those need an external fencing token (`Ownership.ts:116-124`). Keep that caveat prominent.

### Replay keys and content environment — implemented with a dangerous default

- The engine reads `Activity.CurrentContentEnvironment` before key construction (`packages/engine/src/FlowEngine.ts:947-960`).
- Both string and object content identities pass through `withEnvironment`; hard-boundary metadata is also folded in (`:664-712`). Ordinal identities use declaration-scoped `parentScope` (`:714-730`).
- The reference defaults to `{ layers: [], capabilities: {} }` when the composition does not provide it (`packages/engine/src/Activity.ts:358-393`).

So the implementation-status claim that the environment is folded is backed (`implementation-status.md:16`), but “every” hand-wired composition remains a caller obligation. Missing configuration is indistinguishable from a genuinely empty pure environment and can permit stale cross-run reuse after a host/model change. **Recommendation:** represent “undeclared” separately and refuse shared-cache admission until a content environment is explicitly declared; allow an explicit empty environment for proven-pure activities.

Two docs disagree with the implementation and with each other. `docs/concepts/step-keys.md:91-95` says an activity display-name change does not change a content key, while string keys explicitly fold the activity name (`FlowEngine.ts:671-695`) and `docs/concepts/determinism-and-replay.md:53-57` correctly says renaming changes string-key identity. `step-keys.md:54` also says the activity name is intentionally absent from ordinal keys, while the declaration-derived `parentScope` indirectly includes it. Correct these before release.

### Retry budget across process death — backed, with documented retention fallback

`EngineStore` probes persisted attempts for the earliest surviving `startedAtMs` and latest attempt (`packages/engine-store/src/EngineStore.ts:174-209`). `FlowEngine` uses those to preserve schedule-to-close time and the retry counter across a restarted handler (`packages/engine/src/FlowEngine.ts:969-1007`). If retention pruned all attempts, it logs and restarts the budget (`:981-997`); the implementation status credits this limitation (`implementation-status.md:26`). This is an honest, usable invariant. **Verified — source.**

### Cycle detection — backed for conforming databases

`recordRunParent` inserts the edge and walks the parent chain inside `Database.write`, failing the transaction on a cycle (`packages/engine-store/src/DurableEngineState.ts:1127-1164`). The driver wraps edge insertion and run creation in one outer engine-state transaction (`RunDriver.ts:715-779`). `Database.write` uses the SQL client's transaction and retries transient failures (`packages/database/src/Database.ts:168-184`). This backs the SQLite claim and the code has cross-connection tests. The Postgres statement remains a **contract**, not a shipped implementation: a new backend must provide serializable writes, and no Postgres layer/migration exists (`implementation-status.md:57,70`).

### Claims in the status docs that need correction

- “two ticks shorter” is mathematically stale; current value is 19s versus 30s (`implementation-status.md:12`; `Ownership.ts:77-133`).
- “Host bundles … Cloudflare, Vercel” (`implementation-status.md:19`) is not true of this repository's 11 packages; root/docs say those adapters live in a separate plugins repository (`README.md:25-26`, `docs/README.md:56-57`). Reword as external integrations.
- `smithers-replacement-gaps.md` still says no `Supervisor` layer exists in `packages/engine` (`:136`) and lists supervision as “still missing” (`:28`), while current `RunDriver` performs periodic parked/stale sweeps and current reference docs describe them (`docs/reference/engine-store.md:23`). The gap ledger itself calls closing this “a small task, not a subsystem” (`:146-147`) — either land that small task or reconcile the ledger with the shipped sweeper so the public status does not overstate the missing piece.
- The closing claim that the core is “at or above smithers parity” (`smithers-replacement-gaps.md:288-299`) is too broad while its own logical-WAL blocker, packaged-layer gap, plugin dispatch gap, and Postgres gap remain. Scope any parity claim to the specific fenced SQLite store invariants verified.

## 6. Documentation release-readiness

The docs are a product strength worth leading with after cleanup. They have a coherent reading order (`docs/README.md:5-17`), concept/reference separation, source-level architecture diagrams, explicit replay authoring rules, unusually careful caveats around external-effect atomicity, and an authoritative status page that admits the largest blocker. The durability, determinism, step-key, journal, and time-travel concepts are substantially aligned with the code, subject to the contradictions above. **Verified — docs and source spot-check.**

They are not yet standalone public docs:

- Root README is only 37 lines, says “unreleased,” says names are “retained,” and omits `@smthrs/plugin` from the package list (`README.md:1-28`).
- Docs index also says unreleased (`docs/README.md:1-3`), links missing local Cloudflare and Vercel guides (`:34-41`), and omits a plugin package reference from its package list (`:43-54`). A local relative-link scan found four broken occurrences for the two missing guides, also referenced by `docs/concepts/hosts-and-capabilities.md:61`.
- Package READMEs contain **22 links that escape this standalone repository** into the parent-only `docs/specs` vault: database 2 (lines 38-39), engine-store 3 (53-55), engine 3 (293-295), host 2 (58-59), journal 2 (81-82), kernel 4 (55-58), keys 1 (40), plugin 2 (44-45), sync 1 (60), and time-travel 2 (43-44). They happen to resolve in the pseudomonorepo checkout but will not exist in `smithersai/flows` or npm package context.
- `docs/architecture/smithers-replacement-gaps.md` is an internal migration audit whose opening explicitly depends on `~/smithers` and directional line references (`:1-15`). Keep it in an `internal/` or historical design area, not the public first-party architecture path.
- `docs/architecture/plugin-system.md:1-27` references missing `docs/specs` paths and internal harness policy. Rewrite it around public extension use cases.
- Missing standard community files were verified by file inventory: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates, and a pull-request template.

The package READMEs themselves are generally useful API inventories and all exist. Preserve them, replace parent-vault links with standalone concept/reference links, and add one complete runnable example per package where practical.

## 7. CI and repository hygiene

### CI/release automation

The sole workflow runs on pushes to `main` and all pull requests, Ubuntu only, Node 22 only (`.github/workflows/ci.yml:1-17`). It installs `jj` 0.39.0 and gates typecheck, lint, circular checks, and tests (`:18-39`). It does **not** gate builds, dry-run packs, clean consumer installs, browser bundles, Node's exact minimum `22.19.0`, newer Node, macOS/Windows, or Bun. **Verified — source.**

There is no release or publish workflow; `.github/workflows/ci.yml` is the only file under `.github`. Yet every manifest requests `provenance: true`. Add npm trusted publishing with GitHub Actions OIDC, `permissions: id-token: write`, a protected release environment, tag/version validation, topological workspace publishing, and post-publish import/require verification. Do not publish locally. **Release blocker.**

### Hygiene

- `.gitignore` covers `node_modules/`, root and package `dist/`, `coverage/`, `*.tsbuildinfo`, logs, `.env`, and Smithers DB/run artifacts (`.gitignore:1-38`). **Verified — source.**
- A recursive self-symlink named `flows` exists at the repository root and points back to `/Users/williamcory/flows/flows`. It is ignored by `/flows` (`.gitignore:3`), but it can still make tools that follow symlinks recurse forever. Remove it from the checkout setup; ignoring is not remediation. **Verified — `ls -ld`, `file`, `git check-ignore`.**
- The pre-existing `.smithers/claude-mirror-subscriptions.json` was preserved in a named stash with message `preflight oneshot-msgvzk71-60416267: ephemeral Smithers Claude mirror subscription state`. The live Smithers integration recreated the same runtime path during the review, so the recreated copy was isolated separately before handoff; neither copy is goal work. **Verified — git commands.**
- Root `tsconfig.json:7-25` retains path aliases for removed `@earendil-works/pi-*` packages and its include list names removed storage/coding-agent paths (`:28-35`). These stale extraction remnants reinforce that the standalone repo needs a hygiene pass.
- The lockfile is not coherent with the workspace, as proven by `npm ci`; this is a release blocker, not merely a dirty local install.
- A current-tree high-confidence secret scan over tracked files found no private-key headers, GitHub tokens, AWS access-key IDs, Google API-key signatures, or Stripe/OpenAI-style secret patterns. A `git log -G` history scan for private keys, GitHub/AWS tokens, and `sk-*` secrets also returned no commits. No suspicious credential filenames are tracked. **Verified — targeted commands; this is not a substitute for installing a dedicated scanner such as gitleaks in CI.**

## 8. Naming and positioning decisions

These decisions should be made before code or docs freeze. Defaults are recommendations, not questions.

| Decision | Recommended default | Evidence/rationale |
| --- | --- | --- |
| Product name | **Smithers Flows** | Matches README/repo (`README.md:1`) and is searchable enough when paired with Smithers. Avoid the unqualified generic “flows.” |
| Primary package | **Keep `@smthrs/flows-next`** if Smithers controls the npm org | Registry queries on 2026-08-05 PDT returned E404 for all 11 names, which means unlisted/unavailable-to-this-client—not proof of org control. Verify npm-org ownership and reserve names before announcing. |
| Leaf package names | **Rename generic leaves to `@smthrs/flows-*` before first publish** | `@smthrs/kernel-next`, `database`, and `keys` are too generic inside a shared company scope and make provenance/search intent unclear. Pre-1.0 is the cheapest rename window. Keep only the umbrella short. |
| Public package count | **Publish the umbrella plus intentionally supported leaves; mark implementation-only packages clearly** | Eleven independent public contracts create versioning and support burden. The current barrel exposes everything (`packages/flows/src/index.ts:26-35`). |
| Version | **Lockstep `0.1.0`** | Current 0.0.0/0.1.0 mix is incoherent (`packages/*/package.json:4`). `0.1.0` honestly signals experimental but intentional API. |
| Internal ranges | **Exact `0.1.0` in published manifests** | Current exact 0.0.0 and `*` are both wrong for a coordinated first release. Exact lockstep prevents leaf-major drift. |
| Release channel | **Publish `0.1.0` as experimental only after blockers, with explicit durability limitations** | Effect itself is pinned to beta.102 and the logical WAL is non-atomic (`implementation-status.md:42-44`). If WAL remains open, use a prerelease/`next` tag and do not claim production durability. |
| Browser promise | **Promise browser-safe contracts/adapters, not a browser-safe durable engine, until verified** | BrowserHost bundles; host root and umbrella do not. EngineStore imports Node crypto (`EngineStore.ts:20`; bundle command evidence). |
| Storage promise | **SQLite-first in 0.1; Postgres planned** | Both shipped backends/migrations are SQLite and the docs admit no Pg layer (`implementation-status.md:57-70`). |

### Competitive positioning

The honest position is **an embeddable, Effect-native durable-execution toolkit for applications that want durability as Layers and typed services rather than adopting a separate hosted control plane**. Its differentiated combination is Effect schemas/errors/fibers, capability-checked host layers, declaration- and environment-aware cross-run content caching, and explicit time-travel/compensation protocols (`packages/engine/src/FlowEngine.ts:664-730`; `docs/concepts/time-travel.md:18-73`). Temporal is a mature service/cloud platform ([official docs](https://docs.temporal.io/)); Restate supplies a lightweight runtime with durable services, state, promises, and exactly-once-per-ID workflows ([official services docs](https://docs.restate.dev/foundations/services)); Inngest supplies managed coordination, memoized steps, queues/flow control, and serverless execution ([official execution docs](https://www.inngest.com/docs/learn/how-functions-are-executed)); Effect's workflow surface is the upstream unstable API this engine vendors (`packages/engine/VENDOR.md:3-19`). Flows does not yet have their multi-node service, operational control plane, ecosystem, production history, or end-to-end deployment story—and its own current barrel is not browser-safe. Lead with Effect integration, embeddability, content addressing, and time-travel research; do not lead with parity or “exactly once.”

## Final verdict and punch list

### Verdict: ~~NOT YET~~ → READY AFTER npm-org verification, the copyright-holder confirmation, and one release-workflow rehearsal

> **Superseded 2026-08-06.** The paragraph and punch list below describe commit `4e5ca54`, the tree as reviewed. All nine numbered release blockers were closed by the remediation run at `cf6f831`; see [Blocker remediation](#blocker-remediation-post-review-run) for per-blocker status, evidence, and the honest remaining list. The original text is preserved unedited — it is the record of what was found, and its punch list is still the checklist the fixes were graded against.

The repository is promising enough to justify a focused release-hardening cycle, but it is not ready for `npm publish` and not yet at the public bar implied by its competitive set. The local core has unusually strong tests and several credible durability invariants, while the docs deserve credit for admitting major gaps. However, the checked-in tree cannot clean-install in CI, two release gates are red, key tarballs are broken or mis-exported, licensing is wrong, browser promises are not met by root entrypoints, and the logical journal cannot atomically account for executable state. Fixing only package metadata would produce an installable preview, not the “worthy durable-execution library” requested; the logical-WAL and production composition work must land first or the release must be explicitly downgraded to an experimental research preview.

### Release blockers — must fix before `npm publish`

1. **Make lifecycle history atomic with executable state.** Evidence: `docs/architecture/implementation-status.md:42-44`; state-before-event sequences in `packages/engine-store/src/internal/ActivityPersistence.ts:920-985` and `RunDriver.ts:573-593`. Fix: append the logical-WAL record and its run/attempt/cache/deferred projection in one `Database.write` transaction, or make journal append authoritative and derive projections; add crash injection at every interstitial point and assert journal/state equivalence after restart.
2. **Repair and reproduce the lockfile.** Evidence: `npm ci --ignore-scripts` reports missing plugin and TS 6.0.3; `package-lock.json:7985` resolves TS 5.9.3; CI runs `npm ci` at `.github/workflows/ci.yml:18`. Fix: regenerate with the intended npm version and `npm install --package-lock-only --ignore-scripts`, verify all 11 workspace records, then prove `npm ci --ignore-scripts`, the four gates, and builds from an empty `node_modules`.
3. **Make every promised artifact exist.** Evidence: `noEmit: true` at `packages/flows/tsconfig.json:18` and `packages/host/tsconfig.json:18` conflicts with publish targets at `packages/flows/package.json:54-63` and `@smthrs/host`'s `publishConfig.exports`; both successful builds produce only `dist/cjs` (reproduced after deleting `dist`), and the flows pack has no ESM/declarations. Fix: remove `noEmit` from the two main tsconfigs (or otherwise align with working packages) and add an artifact test that deletes `dist`, builds, and imports/requires every export target.
4. **Fix `@smthrs/time-travel-next` publish exports.** Evidence: source exports at `packages/time-travel/package.json:32-37`, publishConfig missing override at `:49-52`. Fix: add the same conditional dist map and internal null blocks as siblings; pack and smoke-test both module systems from outside the monorepo.
5. **Correct authorship/upstream attribution and ship licenses.** Evidence: `LICENSE:3`; Effect vendor record `packages/engine/VENDOR.md:3-19`; Effect notice `/Users/williamcory/flows/reference/effect/LICENSE:1-13`; dry-run packs contain no license. Fix: identify the actual flows copyright holder, remove unsupported pi attribution, preserve Effectful Technologies' notice, and include license/third-party notice files in every tarball.
6. **Turn all mandated gates green — including the flaky ones.** Evidence: engine-store/sync coverage output and `packages/*/vitest.config.ts` thresholds; lint errors above; `host` branch-gate flap (99.61% under concurrency) and 5,000ms-timeout failures in `test/BrowserFileSystem.test.ts:6` and `test/NodeJj.test.ts:58` on re-runs. Fix: cover the missing branches/line and format/type-import errors; make wall-clock-sensitive tests deterministic (hermetic clocks, generous or condition-based timeouts for subprocess/streaming tests — the pattern already used in `test(host): prove the jj kill with a process-exit condition`, commit `e8d30f3`); do not lower the deliberate thresholds merely to release.
7. **Honor or narrow the browser contract.** Evidence: `packages/host/src/index.ts:17-23` and `packages/engine-store/src/EngineStore.ts:20`; browser bundle commands fail with 129/131 errors while BrowserHost succeeds. Fix: keep root contracts Node-free, move platform/test adapters to subpaths, add browser-bundle CI, and describe EngineStore as Node/SQLite until an edge-safe owner/store exists.
8. **Add a release pipeline compatible with provenance.** Evidence: `.github/workflows/ci.yml` is the only workflow and has no publish job; manifests request provenance (`packages/*/package.json`, representative `packages/database/package.json:49-52`). Fix: GitHub OIDC trusted publishing, protected environment, tag/version checks, topological publish, and post-publish smoke tests.
9. **Choose names and normalize release versions/ranges.** Evidence: kernel `0.1.0` versus other `0.0.0`, and mixed `*`/exact ranges (`packages/kernel/package.json:4,77-80`; `packages/flows/package.json:77-88`; `packages/engine-store/package.json:77-83`). Fix: reserve scope, apply the naming defaults above, set all public packages to `0.1.0`, and emit exact lockstep internal ranges.

### High priority — first release cycle

1. Ship a packaged production SQLite layer and a crash/restart getting-started example (`implementation-status.md:48-53`; `docs/guides/durable-engine.md:48-79`).
2. Make missing content-environment configuration a cache-admission failure rather than silently empty (`packages/engine/src/Activity.ts:358-393`).
3. Correct status/doc contradictions: heartbeat math, external host adapters, supervisor wording, string-key rename behavior, and parity conclusion (evidence in §5).
4. Rewrite docs to stand alone: fix two missing guide targets and 22 parent-vault links; move the Smithers replacement ledger out of the public path (evidence in §6).
5. Add the three missing changelogs and release sections (`packages/flows`, `plugin`, `sync` manifests at lines 39-47).
6. Add CONTRIBUTING, SECURITY (with private vulnerability reporting), CODE_OF_CONDUCT, issue/PR templates, support policy, and compatibility matrix.
7. Rationalize the public API: reset `@since`, add `@category` to entrypoints, remove/justify `namespaces`, and move test/platform utilities to explicit subpaths (§4).
8. Add CI matrices for Node 22.19 and current, browser bundles, clean packed-consumer ESM/CJS/types tests, and at least one macOS/Windows or clearly documented Unix-only stance (`.github/workflows/ci.yml:8-39`).
9. Resolve the raw TypeScript `@smthrs/host/test/contract` export (`packages/host/package.json:35,47,61`).
10. Remove stale pi aliases from root TypeScript config and the recursive self-symlink (`tsconfig.json:7-35`; command evidence).

### Nice to have

1. Stop shipping `src`/internal implementation files when declarations plus source maps are sufficient (`packages/*/package.json:39-47`).
2. Add API report generation and semver-diff checks for all public namespaces.
3. Add a dedicated secret/license/dependency scan and SBOM to release CI; the targeted manual scan found no high-confidence secrets.
4. Add Postgres/PGlite only after the SQLite release is solid, then run the same database/store contract suites against it (`implementation-status.md:57-70`).
5. Publish benchmark methodology only after correctness gates; compare restart latency, journal throughput, and memory under bounded histories without parity marketing.

### Suggested release sequence

1. Freeze the product/package naming decisions; verify control of the `@smthrs` npm organization and reserve every intended name (registry query currently returns E404 for all 11).
2. Correct licensing and authorship; add Effect third-party notice and package-local license files.
3. Implement atomic logical-WAL/state commits and extend the fault matrix to every state/event interstitial crash; keep time travel/sync non-authoritative until this is green.
4. Add the production SQLite composition layer and one restart smoke application outside the workspace.
5. Normalize all package names/versions to the chosen `0.1.0` line and exact internal ranges; regenerate the lockfile so `npm ci --ignore-scripts` succeeds.
6. Fix flows/time-travel/host exports and build every workspace from deleted `dist`; pack every package and test install, types, ESM, CJS, internal-block behavior, and browser-safe entrypoints from a temporary external project.
7. Make `check`, `test`, `lint`, and `circular` green under clean Node 22.19 and current Node; add build/pack/browser gates to CI.
8. Make the docs standalone, correct status claims, add the durable getting-started path and missing community/security files, and write 0.1.0 changelogs.
9. Configure npm trusted publishing with GitHub OIDC/provenance, a protected environment, tag-to-version validation, and topological publish. Test the workflow against a prerelease/`next` tag if policy permits.
10. Tag `v0.1.0`, let CI publish, then verify every registry tarball, provenance attestation, license, README, ESM/CJS/types entry, and the external restart smoke before moving the dist-tag to `latest`.
