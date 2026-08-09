# @smthrs/engine

## [Unreleased]

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
