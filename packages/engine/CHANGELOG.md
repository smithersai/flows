# @smthrs/engine

## [Unreleased]

### Changed

- Renamed `Flow.withCompensation` to the clearer `Flow.withRollback`.
- Moved `BoundaryMode` beside the `Activity` model it configures.
- Split the `Flow` module into focused definition, result, runtime, annotation,
  constructor, and error files without changing the `@smthrs/engine/Flow`
  import.
- Split `Activity` and its identity, boundary, retry, context, constructor, and
  error code into focused files without changing its public import paths.

### Fixed

- Scoped sealed activity keys to one run until the composition declares its
  complete layer and capability identity.

## [0.1.0] - 2026-08-05

### Added

- Added the vendored durable flow engine with caller-selected execution
  identity, caller-computed activity keys, explicit infrastructure-interrupt
  retry, durability tiers, snapshot boundaries, and signal-assisted resume.

### Fixed

- Kept coverage thresholds on the explicit coverage command so ordinary
  `vitest run` remains the package test gate.
