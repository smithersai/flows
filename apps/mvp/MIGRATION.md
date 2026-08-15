# Migration: smithers-mvp -> flows monorepo (apps/mvp)

## Provenance

- Source path: `/Users/williamcory/mvp`
- Source repo URL: https://github.com/smithersai/mvp.git
- Source branch: `oneshot-msqio9dk-23385906`
- Source HEAD sha: `0e3e71cc9808c2a86569e168618ce6490dc570f5`
- Migration date: 2026-08-15
- Destination: `apps/mvp` in the monorepo at `/Users/williamcory/flows/flows`

The copy carries the CURRENT working-tree state of the source, including
uncommitted changes: staged additions under `src/mainview/cards/` and
`src/mainview/state/seams/` (plus `MULTI-ACTIONS-GAP.md`,
`src/mainview/state/MessageScrub.ts`, `src/mainview/state/RepoContext.ts`,
and related test files) and tracked-file modifications that were present in
the source working tree at migration time.

Copy method: `git -C /Users/williamcory/mvp ls-files --cached --others
--exclude-standard` enumerated 602 files (tracked at HEAD + uncommitted
modifications + staged additions, excluding `.git`, `node_modules`, `build`,
`dist`, `coverage`, `smithers.db*`, and everything matched by the source
`.gitignore`). All 602 files were copied preserving paths and verified by
byte-for-byte comparison against the source: 602/602 identical. `vendor/`
(vendored `@smthrs/*` packages) and `bun.lock` were carried over.

## Deviation from the source tree: regenerated bun.lock

The source `bun.lock` could not be installed by the available bun
(1.4.0-canary.1): `bun install` (and `bun install --frozen-lockfile`) hung
indefinitely in dependency resolution with the source lockfile present,
reproduced both in `apps/mvp` and in an isolated directory outside the
monorepo. This is a bun canary resolution bug with that lockfile, not a
path problem. Fix: `bun.lock` was regenerated in place by `bun install`.
The regenerated lockfile resolves the identical dependency set; the only
content difference from the source lockfile is two transitive patch bumps
(`baseline-browser-mapping` 2.11.13 -> 2.11.14, `electron-to-chromium`
1.5.405 -> 1.5.407). No other file under `apps/mvp` was modified relative
to the source state; no tsconfig paths, imports, or hardcoded paths
required move-related fixes (no relative import reaches outside the app).

## Verification results (all run inside apps/mvp)

- `bun install` — PASS (632 packages installed in ~4s after lockfile
  regeneration; one postinstall blocked by bun trust policy, same as
  upstream behavior)
- `bun run typecheck` (`tsc --noEmit`) — PASS (no errors)
- `bun run test` (`bun test src`) — PASS (560 pass, 0 fail, 2425 expect()
  calls, 55 files)
- `bun run build` (`vite build`) — PASS (built in ~6s; output in
  `apps/mvp/dist`, chunk-size warning only)

## Constraints honored during migration

No `git`, `jj`, or `pnpm` command was run anywhere in
`/Users/williamcory/flows/flows` (only read-only `git -C
/Users/williamcory/mvp ...` against the source repo). No existing monorepo
file was edited; `pnpm-workspace.yaml` is untouched. Nothing in
`/Users/williamcory/mvp` or `/Users/williamcory/flows/mvp` was modified or
deleted. Nothing was pushed.

## Deferred follow-ups (deliberately not done while other runs share this tree)

1. Scoped `jj` commit of `apps/` — deferred because two other agent runs
   are actively working in the same jj-colocated working copy; committing
   here could sweep up their in-flight files.
2. Decision on adding `"apps/*"` to `pnpm-workspace.yaml` — deferred. The
   app is bun-managed and self-contained (own `bun.lock`, own
   `node_modules`, `file:vendor/...` dependencies), so pnpm workspace
   membership is optional and can be decided later without blocking use of
   the app.
