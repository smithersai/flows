# Changelog

## [Unreleased]

### Added

- Added `webfetch`, `websearch`, and `lsp` flows with provider-neutral service boundaries.

### Changed

- Allowed hermetic Bash invocations to use the resolved base directory as their working directory without declaring it as a read.
- Exempted `/dev/*` from the hermetic Bash path scan; process plumbing is not a workspace effect.

### Fixed

- Made `edit` locate its block tolerantly (exact, then trailing-whitespace-insensitive, then collapsed-whitespace line matching) and report the nearest actual region on a miss; two benchmark runs burned their whole frame budget on whitespace-guessing loops. Prior art: `reference/opencode` `tool/edit.ts`.

- Stopped `grep` and `glob` walks from descending into version-control, dependency, and cache directories; one `.git` descent held a frame for its whole evaluation ceiling.

- Reported a directory entry whose metadata cannot be read as a plain entry instead of failing the whole `ls` listing.
