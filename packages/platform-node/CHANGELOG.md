# @smthrs/platform-node

## [Unreleased]

### Added

- Initial extraction from the dissolved `@smthrs/host`. `NodeHost` and
  `NodeHttpTransport` moved here unchanged in behaviour; `NodeJj` had already
  moved to `@smthrs/jj` and is composed from there.

### Removed

- `NodeShell` is gone. Process execution is Effect's `ChildProcessSpawner`, and
  `NodeHost.layer` now provides `@effect/platform-node`'s implementation of it
  directly. The wrapper's one extra feature, `timeoutMs`, is `Effect.timeout`
  around any effect.
