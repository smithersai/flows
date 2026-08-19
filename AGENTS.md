# Development Rules

## Correction note (2026-08-18)

This file is copied from the outer repository at `/Users/williamcory/flows/AGENTS.md`.
It is the development-rules document inherited with the `pi` tree. Two classes of
correction were applied during the copy.

1. Toolchain. The inherited text described npm, `package-lock.json`, and `npm ci`.
   This repository uses pnpm: `package.json` pins `packageManager: "pnpm@11.21.0"`,
   the lockfile is `pnpm-lock.yaml`, and every root script runs
   `pnpm --recursive --if-present run <script>`. The Commands and Dependency
   sections below name pnpm commands that exist here. `.npmrc` holds only auth and
   registry settings; every other pnpm setting lives in `pnpm-workspace.yaml`,
   which the root `BUILD.ts` generates.
2. Repository. Several sections describe the `pi` repository, not this one. They
   are kept for reference and marked inline: "Testing pi Interactive Mode with
   tmux" (no `pi-test.sh` here), "Releasing" (this repo releases through
   `scripts/pack-release.mjs` and `.github/workflows/release.yml`), and the
   `packages/coding-agent`, `packages/ai`, and `packages/tui` references (no such
   packages here; `ls packages/` lists 45 `@smthrs/*` packages).

Everything else is unchanged and applies to code in `packages/`.

## Conversational Style

- Keep answers short and concise
- Always use emoji conventional commits (see Committing below); no emojis in issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- (pi repository only, no `packages/ai` here) Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate.

## Commands

- After code changes (not docs): `pnpm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `pnpm --recursive --if-present run build` or `pnpm test` unless requested by the user.
- Run one package's tests from that package root with `pnpm exec vitest run test/specific.test.ts`, or from the repo root with `pnpm --filter @smthrs/<package> test`. vitest is installed per package, not at the workspace root, so `node ../../node_modules/vitest/dist/cli.js` does not resolve here.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- (pi repository only) For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens. Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat dependency and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- The lockfile is `pnpm-lock.yaml`. There is no `package-lock.json` and no shrinkwrap in this repository.
- Hydrate or update locally with `pnpm install --ignore-scripts`; reproduce CI with `pnpm install --frozen-lockfile --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dependency metadata changes, refresh the lockfile alone with `pnpm install --lockfile-only --ignore-scripts`.
- `.npmrc` carries auth and registry settings only. Every other pnpm setting is declared in the root `BUILD.ts` and generated into `pnpm-workspace.yaml`; edit the declaration, not the generated file.
- There is no pre-commit lockfile hook here, so `PI_ALLOW_LOCKFILE_CHANGE` has no effect. Say in the commit message why the lockfile changed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Always ATOMIC commits: one coherent completed unit per commit, never `git add -A`.
- Message format: emoji conventional commit — `<emoji> <type>(<scope>): <description>` (e.g. `✨ feat(harness): ...`, `🐛 fix(model): ...`, `📚 docs(site): ...`, `🧪 test(...)`, `🧹 style/chore(...)`, `🔧 fix(config)`). Message is informative and concise; multiple lines allowed.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages; use all that apply. (The label set listed in the pi document — `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui` — is that repository's, not this one's.)

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by`/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

pi repository only. There is no `pi-test.sh` in this repository. Kept for reference:

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

pi repository only. This repository ships no `CHANGELOG.md`; release notes come from `scripts/pack-release.mjs` and `.github/workflows/release.yml`. Kept for reference.

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

pi repository only. This repository releases through `scripts/set-release-version.mjs`, `scripts/pack-release.mjs`, `scripts/smoke-release.mjs`, and `.github/workflows/release.yml`, all gated by `node --test` steps in `.github/workflows/ci.yml`. The npm commands below do not exist here. Kept for reference.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

<!-- smithers:prefer-workflows START -->

## Smithers workflows

Use your best judgment, weighing speed, quality, and token usage, to decide
whether a request should run as a [smithers.sh](https://smithers.sh) workflow
or with regular subagents. Prefer a smithers workflow for multi-step plans and
for work that benefits from retries, approvals, review, or replay; reach for
plain subagents when a request is a quick one-off.

The `smithers` skill is installed: run `smithers workflow list` to see the
available workflows and `smithers workflow run <id>` to launch one.

When a session ends successfully and the work could have been a smithers
workflow, offer to turn the session into a reusable smithers workflow for next
time.

<!-- smithers:prefer-workflows END -->

## New flows packages mirror the effect repo

Everything under `packages/` written for `flows` copies the **effect repo's** structure and idioms exactly —
`reference/effect` is the template, not inspiration:

- File structure: one module per service/concept, `src/index.ts` as namespace
  re-exports (`export * as Foo`), `test/*.test.ts`.
- Naming: contracts export `make` / `makeNoop` / `layerNoop`; implementations
  export `layer` (variants as `layer<Variant>`); platform impl modules named
  `Node<Service>.ts` / `Browser<Service>.ts` like `platform-node`/`platform-browser`.
- Errors: shared domain errors in a named module (`PlatformError.ts` style) or
  colocated in the service module (`Socket.ts` style) — never a generic
  `errors.ts`.
- Docs: `@since` / `@category` JSDoc on every public export.
- Tooling: the same lint/format/circular-check setup the effect repo uses.
- `package.json`: same shape as an effect package — same field order, `exports`
  map style, `sideEffects`, pinned versions, and script names (`check`, `test`,
  `coverage`, `lint`, `build`).
- Build: the same build process the effect repo uses (their build scripts and
  output layout for dual ESM/CJS + `.d.ts`), scaled down to our monorepo. Copy
  a real effect package's `package.json` + build config as the starting point.

When in doubt about any convention, open the corresponding file in
`reference/effect` and copy what it does.
