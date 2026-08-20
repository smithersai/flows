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

---

# 2026-08-15: apps/mvp split into apps/{ui,server,shared}; vendoring removed

Both deferred follow-ups above are now resolved: `apps/*` is a pnpm
workspace member, and everything is committed on `merge-agent-packages`.

## What changed

- `apps/mvp` no longer exists. The split (pure git renames, history
  preserved):
  - `apps/ui` (`smithers-ui`) — the Electrobun + React app. The former
    `src/server` is now `src/dev`: it is the vite dev/preview AgentApi
    middleware, not a deployable.
  - `apps/server` (`smithers-server`) — the Cloudflare Worker, former
    `src/worker`. The wrangler `name` stays `smithers-mvp-web` and its
    routes/durable_objects/migrations/vars are byte-identical (verified by
    SHA-256 against the pre-split config); renaming the Worker would orphan
    the Durable Object state and the canary.smithers.sh domain binding.
    Only `main` and `assets.directory` (`../ui/dist`) changed.
  - `apps/shared` (`smithers-shared`) — the agent contract, former
    `src/shared`, imported as `smithers-shared/<Module>` via an exports
    map. Runtime-free by design law (its own test forbids `@smthrs/*` and
    `effect` imports).
  - Product-level docs (this file, DESIGN.md, WAVE receipts, reports/)
    moved up to `apps/`.
- `vendor/smthrs/` (14 packages, vendored 2026-08-12 from
  `flows@20cedc3` + `agent@ed41681`), `scripts/vendor-smthrs.mjs`, and the
  per-app `bun.lock` are deleted. `@smthrs/*` dependencies are now pnpm
  workspace links into `packages/` under their current names (several are
  `-next`: canonical, capability, chain, crypto, database, jj, journal,
  kernel, platform-browser; bare: core, memory, model, patterns, registry;
  `@smthrs/ui` remains a published npm dep). `effect` moved
  `4.0.0-beta.102` → `4.0.0-rc.108` (the workspace pin).
- `@smthrs/chain` was promoted to `packages/chain` as `@smthrs/chain`.
  Why: the upstream agent repo deleted its source (only `dist/` leftovers
  remain there) and the merge spec excluded it, so the vendored copy was
  the only living source. It was verified md5-identical to `agent@ed41681`
  (the vendor-manifest pin), and its 21-file test suite plus build
  boilerplate were restored from that exact commit
  (`scripts/prompts.mjs` regenerates `src/internal/prompts.ts`
  byte-identically, confirming provenance). Known upstream work NOT
  carried: the agent repo's chain lineage after `ed41681` (7 commits
  through 2026-08-13, incl. "retire the flowFacade").

## Verification

- `pnpm -C apps/shared typecheck` + `bun test`: 33/33.
- `pnpm -C apps/server typecheck` + `bun test`: 100/100;
  `bun x wrangler deploy --dry-run` passes (190 assets from `../ui/dist`,
  both DO classes resolve).
- `pnpm -C apps/ui typecheck` (0 errors) + `bun test` (465/465) +
  `pnpm -C apps/ui run build` emits `apps/ui/dist`. Vite invocations carry
  `--configLoader runner` so `vite.config.ts` can load the TS-source
  `smithers-shared` package.
- `packages/chain`: effect rc.108 conformance (TaggedErrorClass →
  `Schema.TaggedError<Self>()` idiom et al.) — see the package's own gate
  run in the commit history.

## Known follow-ups

- Done: `apps/ui/.gitignore` dropped the stale `!reports/live-checks/wave13c/*.log`
  rule (that evidence now lives at `apps/reports/live-checks/wave13c/`), and the
  remaining `reports/chat-shell/` ignore now names the script that writes there
  (`scripts/web-chat-shell-e2e.ts`).
- `packages/chain` service/error identity strings are still `"/chain/…"`;
  repo rule says identity = defining module path. Durable-key decision
  deferred to will.
- Done: `scripts/browser-check.mjs` browser-safe entry list already includes
  `@smthrs/chain` (landed in b57af599); verified green via
  `node scripts/browser-check.mjs`.
