# @smthrs/sandbox

## [Unreleased]

### Changed

- `RemoteSandbox` now adapts a provider onto Effect's `ChildProcessSpawner`
  rather than the deleted `Shell` service. A provider hands back a started
  remote process in the same three pieces a child process has — `stdout`,
  `stderr`, `exitCode` — and `layer` (formerly `layerShell`) normalizes provider
  failures onto `PlatformError`. Piping stdin and killing by signal are declared
  unsupported rather than silently dropped; a remote process ends by closing its
  scope.
- `ProviderError` carries its own closed `ProviderErrorCode` set (`aborted`,
  `timeout`, `unavailable`, `spawn_error`, `unknown`) instead of borrowing the
  shell's. The schema `_tag` is unchanged.
- The package now depends on `@smthrs/kernel` — for `CommandLine.render` alone —
  instead of `@smthrs/host`.

### Changed

- Split remote execution and sandbox health into focused model, service,
  adapter, probe, and layer files without changing public imports.

### Added

- Split `RemoteSandbox` and `SandboxHealth` out of `@smthrs/host` into their own
  package. Every schema `_tag` is unchanged: they are durable identity, not
  source location.
