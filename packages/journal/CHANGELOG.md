# @smthrs/journal

## [Unreleased]

### Added

- `Redaction.verbatimNamespaces` / `Redaction.isVerbatimEventType`: entries in
  fold namespaces whose payloads are executable state (`flows.cache.*`) bypass
  the write-path redactor, because the fold rebuilds served rows from them —
  see `docs/specs/Concepts/Step Cache Fold.md`.
- The deferred/clock fold's five fold-input event types
  (`flows.engine.deferred-completed`, `flows.engine.clock-scheduled`,
  `flows.engine.clock-completed`, `flows.engine.deferred-snapshot`,
  `flows.engine.clock-snapshot`) join `Redaction.verbatimNamespaces` as exact
  entries: prefix matching makes a full event-type string an exact entry, so
  the rest of `flows.engine.*` stays redacted — see
  `docs/specs/Concepts/Deferred Clock Fold.md`. The bypass is journal-owned
  allowlist policy; `JournalEvent.Input` carries no per-entry flag.

### Breaking Changes

- The stores and `SqlJournal` now require Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service) instead of the bundled
  `Database` service.

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
