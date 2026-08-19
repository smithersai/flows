# Changelog

## [Unreleased]

### Added

- Added `webfetch`, `websearch`, and `lsp` flows with provider-neutral service boundaries.

### Changed

- Allowed hermetic Bash invocations to use the resolved base directory as their working directory without declaring it as a read.
- Exempted `/dev/*` from the hermetic Bash path scan; process plumbing is not a workspace effect.

### Fixed

- Reported a directory entry whose metadata cannot be read as a plain entry instead of failing the whole `ls` listing.
