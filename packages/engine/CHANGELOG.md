# @smithers/engine

## [Unreleased]

### Added

- Added the vendored durable flow engine with caller-selected execution
  identity, caller-computed activity keys, explicit infrastructure-interrupt
  retry, durability tiers, snapshot boundaries, and signal-assisted resume.

### Fixed

- Kept coverage thresholds on the explicit coverage command so ordinary
  `vitest run` remains the package test gate.
