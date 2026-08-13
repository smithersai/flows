# @smthrs/step-cache-next

## [Unreleased]

### Added

- Split out of `@smthrs/journal-next`: `CacheStore` now lives here, and the package
  owns the `flows_step_cache` migration. No schema or behavioural change — see
  `docs/specs/Concepts/Journal Split.md`.
