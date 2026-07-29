# Changelog

## [Unreleased]

### Fixed

- Removed composition-time throws and structural boundary sniffing by using
  Deferred service wiring and Schema-backed boundary descriptors.
- Supervised ownership heartbeats through structured interruption races.

### Added

- Added the journal-backed workflow-engine composition, claim-gated run
  driver, durable deferred and absolute-clock state, activity persistence
  wiring, and deterministic test layers.
