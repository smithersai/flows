# @smthrs/platform-bun

## [Unreleased]

### Added

- Initial extraction from the dissolved `@smthrs/host`. `BunHost`,
  `BunFileSystem`, and `BunHttpTransport` moved here unchanged in behaviour;
  `BunJj` had already moved to `@smthrs/jj` and is composed from there.

### Removed

- `BunShell` is gone, and with it the hand-rolled runtime detection that chose
  between `Bun.spawn` and `node:child_process`. `BunHost.layer` provides
  `@effect/platform-bun`'s `ChildProcessSpawner`, which is
  `@effect/platform-node-shared`'s implementation re-exported — the same code on
  both runtimes, so there is nothing left to detect.
