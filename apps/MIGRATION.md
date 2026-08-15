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
`.gitignore`). All 602 files were copied preserving paths and count-verified.
The review comparison found 601/602 byte-for-byte identical; the only
intentional content difference is the app-local `.gitignore`, which adds
negations for the monorepo root's broad `.smithers/` and `*.log` rules. Those
negations keep the source app's tracked workflow pack and eight tracked live-
check evidence logs visible when `apps/` is eventually committed. `vendor/`
(vendored `@smthrs/*` packages) and the source `bun.lock` were carried over
byte-for-byte.

## Bun canary install workaround

The available bun (1.4.0-canary.1) does not finish dependency resolution
when this source lockfile is already present. For verification only, the
lockfile was temporarily set aside, plain `bun install` was run in
`apps/mvp`, and the original source lockfile was restored afterward. The
successful install generated the same dependency graph with two newer
transitive patch releases, but that generated lockfile was discarded so the
migration continues to carry the source dependency lock byte-for-byte. This
is a bun canary lockfile-resolution issue, not a path-sensitive breakage.

No tsconfig paths, imports, or hardcoded source-path references required
move-related fixes. No relative import reaches outside the app.

## Verification results (all run inside apps/mvp)

- `bun install` — PASS with the source lockfile temporarily set aside due to
  the bun canary issue described above (38 package links refreshed in 1.4s;
  the existing local install contains 632 resolved packages)
- `bun run typecheck` (`tsc --noEmit`) — PASS (no errors)
- `bun run test` (`bun test src`) — PASS (560 pass, 0 fail, 2425 expect()
  calls, 55 files)
- `bun run build` (`vite build`) — PASS (built in ~54s; output in
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
