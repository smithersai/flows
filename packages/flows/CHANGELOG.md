# @smthrs/flows

## [0.1.0] - 2026-08-05

### Added

- Added the barrel package that re-exports every `@smthrs/*` engine package
  as a namespace — `Database`, `Engine`, `EngineStore`, `Host`, `Journal`,
  `Kernel`, `Keys`, `Plugin`, `Sync`, and `TimeTravel` — so one dependency
  gives you the whole engine surface without collapsing each package's
  `make` / `makeNoop` / `layerNoop` trio into a shared namespace.
- Added `namespaces`, the runtime list of the re-exported namespace names,
  which also gives the barrel's coverage gate a real denominator.
