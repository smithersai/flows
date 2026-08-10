# @smthrs/sandbox

## [Unreleased]

### Changed

- Split remote execution and sandbox health into focused model, service,
  adapter, probe, and layer files without changing public imports.

### Added

- Split `RemoteSandbox` and `SandboxHealth` out of `@smthrs/host` into their own
  package. Every schema `_tag` is unchanged: they are durable identity, not
  source location.
