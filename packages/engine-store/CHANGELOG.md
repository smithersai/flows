# Changelog

## [Unreleased]

### Added

- `Fold`: the deferred/clock journal fold. `deferredProjection` and
  `clockProjection` reduce the fold-input records into the
  `flows_deferred_completions` / `flows_clock_deadlines` rows, and `rebuild`
  truncates and repopulates both tables from the journal inside one
  `DurableWriter` transaction, demoting them from contract to rebuildable
  wakeup indexes (`docs/specs/Concepts/Deferred Clock Fold.md`).
- `flows.engine.clock-completed` records the clock `completed_at_ms`
  compare-and-set in the same write transaction, and the administrative
  `flows.engine.deferred-snapshot` / `flows.engine.clock-snapshot` records
  carry full rows for migration backfill and compaction checkpointing.
  Migration `0003_deferred_clock_fold` backfills one snapshot per surviving
  row so a pre-fold database survives migrate, drop, and rebuild.

### Changed

- `flows.engine.deferred-completed` payloads are self-contained (they carry
  `completedAtMs`) and, like every fold-input record, persist byte-exact past
  the journal's write-path redactor via an exact entry in the journal-owned
  `Redaction.verbatimNamespaces` allowlist. A duplicate completion
  (`Existing`) appends nothing.
- A clock fire commits as one transaction — clock CAS, clock-completed
  record, deferred row, deferred record — and validates against the row
  first, so a deadline completed early is skipped instead of resolving a
  deferred nobody armed (temporal's fire-time validation).

- Required an owner-liveness probe when constructing the durable engine.
- `DurableEngineState` now requires Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service).

### Fixed

- Required explicit whole-tree write verification before admitting a sealed
  result to the cross-run cache.
- Quarantined corrupt boundary evidence off succeeded attempt rows after
  journalling the inconsistency, so a later resume returns the durable outcome
  without re-executing the action
  ([#171](https://github.com/smithersai/flows/issues/171)).
- Included recorded-row provenance in corruption journal identities so an
  identically re-corrupted row records a new incident after healing
  ([#172](https://github.com/smithersai/flows/issues/172)).

## [0.1.0] - 2026-08-05

### Fixed

- Removed composition-time throws and structural boundary sniffing by using
  Deferred service wiring and Schema-backed boundary descriptors.
- Supervised ownership heartbeats through structured interruption races.

### Added

- Added the journal-backed engine composition, claim-gated run
  driver, durable deferred and absolute-clock state, action persistence
  wiring, and deterministic test layers.
- Added SQL-backed deferred completions and clock deadlines with owner-fenced
  scheduling, first-writer completion, and restart recovery.
