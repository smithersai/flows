# @smthrs/journal

## [Unreleased]

### Changed

- `RunStore.get` and the `claimAndOwn` snapshot-loss check run as plain reads
  instead of write transactions.

## [0.1.0] - 2026-08-05

### Fixed

- Kept journal admission, JSON validation, persistence normalization, and
  ownership heartbeat loss in typed Effect failure/interruption channels.
- Replaced structural `_tag` probing with Schema and Effect SQL error guards.

### Added

- Added the non-blocking journal, fenced run and attempt stores, run coordinator, migrations, and content-addressed cache.
- Added migration 0002 for durable deferred completions and absolute clock deadlines.
