# Adoption in the flows repository

The flows monorepo dogfoods smithers build on itself. This page records what is
adopted today, what still runs through plain pnpm scripts, and the criteria
for moving the boundary. Dates are absolute because this page is a status
record, not a design.

## Adopted (2026-08-15)

- **Targets for every package.** The root `BUILD.ts` declares
  `PackageDefaults({ directories: "packages/*", macro: StandardPackage })`, so
  every package without its own `BUILD.ts` synthesizes six targets: `lib`
  (TsBuild), `check` (Typecheck over `tsconfig.test.json`, scheduled after
  `lib`), `test` (Vitest), `lint` (EsLint), `fmt` (Dprint), and `docs`
  (DocsParity). Four packages declare targets by hand — `packages/flow`
  (the desugared form, kept equivalent to the macro), `packages/engine`,
  `packages/plan`, and `packages/build` — and
  `build-cli/test/CommittedBuildFiles.test.ts` loads every committed
  `BUILD.ts` on each test run so a targets-API change cannot silently
  invalidate one again.
- **Gate parity at the package level.** `smthrs ci "//packages/..."` plans
  130 targets over 26 packages. `lib` + `check` cover what the package
  `check` scripts cover; `lint` + `fmt` cover the package `lint` scripts;
  `test` runs the same vitest configs, including their coverage gates.
- **A shadow CI lane.** `.github/workflows/ci.yml` runs
  `smthrs ci "//packages/..."` as the advisory `smthrs-shadow` job on
  every push. Its first flight found two real defects (the pnpm
  `verify-deps-before-run` mid-gate reinstall, now off via the repo
  `.npmrc`, and the withheld `CI` variable, now inherited by `ExecLive`),
  which is the lane's purpose.
- **Verb-aware package labels.** `smthrs lint //packages/plan` selects the
  package's lint-participating targets instead of refusing on the
  build-only default target.

## Not yet adopted

- **Root-level gates.** The circular-dependency guard, the browser bundle
  guard, `scripts/pack-release.test.mjs`, and `scripts/flows-backup.test.mjs`
  run only as workflow steps. Expressing them as targets needs a catalog
  target for root-anchored script runs; hand-rolled `Target.make` calls in the
  root `BUILD.ts` are against the configuration style.
- **Workflow generation.** `.github/workflows/ci.yml` is hand-written. The
  `GithubCiGen` root target is deliberately withdrawn until generation is
  adopted, because its write mode's default output is the real workflow
  file.
- **Caching.** TsBuild, Typecheck, Vitest, EsLint, and Dprint are
  `cache: false`: their input contracts are not yet complete key material
  (the external toolchain versions are not folded in). Until they opt in,
  the shadow lane re-runs everything. The remote cache service is
  implemented but not deployed, and no `RemoteCache` declaration exists in
  the root `BUILD.ts`.
- **The `docs` verb in ci.** DocsParity joins the `ci` verb set once the
  README backfill (factory queue item 0007) lands.

## Promotion criteria for the shadow lane

1. The lane holds a green streak whose verdicts match the enforced pnpm
   gates on the same commits.
2. Root-level gates exist as targets, so the lane's surface is a superset
   of the `test` job's script steps, not just its package-level portion.
3. The workhorse targets opt into caching with complete input contracts, so
   the lane's wall-clock earns the migration.

When all three hold, the lane becomes required and the recursive pnpm
scripts retire from the `test` job.
