# @smthrs/step-cache

## [Unreleased]

### Breaking Changes

- The SQL `CacheStore.layer` requires the `Journal` in context and the
  journal's migration set installed: every row change now appends a
  `flows.cache.*` event in the same `DurableWriter` transaction, so the two
  tables are rebuildable materializations of the journal — see
  `docs/specs/Concepts/Step Cache Fold.md`. `Migrations.run`/`Migrations.layer`
  compose the journal's set as a prerequisite, and the `0002_journal_fold`
  migration backfills one `flows.cache.snapshot` per pre-fold row so existing
  entries are never orphaned from history.

### Added

- `Fold`: the head and ledger reducers as journal `Projection`s, and
  `rebuild`, which truncates and repopulates both tables from the retained
  journal inside one `DurableWriter` transaction.
- `test/TestCacheStore.layer` provides the journal the fold appends to
  alongside the migrated cache.
- Split out of `@smthrs/journal`: `CacheStore` now lives here, and the package
  owns the `flows_step_cache` migration. No schema or behavioural change — see
  `docs/specs/Concepts/Journal Split.md`.
