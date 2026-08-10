# Changelog

## [Unreleased]

### Removed

- Moved `browser/BrowserFileSystem` out of this package and into
  `@smthrs/platform-browser`, where it sits beside the browser
  `ChildProcessSpawner` as an implementation of an `effect` platform service.
  `BrowserHost` and `TestHost` now import it from there; import
  `@smthrs/platform-browser/BrowserFileSystem` instead of
  `@smthrs/host/browser/BrowserFileSystem`.

### Changed

- Emitted the reusable Host contract as ESM, CJS, and declarations from the
  public `@smthrs/host/test/contract` subpath.

### Fixed

- Made shared Host timeout and process-interruption tests deterministic.

## [0.1.0] - 2026-08-05

### Added

- Added the initial portable Host contracts and Node, browser, and test layers.
