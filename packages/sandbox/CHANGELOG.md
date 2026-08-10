# @smthrs/sandbox

## [Unreleased]

### Added

- Split `RemoteSandbox` and `SandboxHealth` out of `@smthrs/host` into their own
  package. Every schema `_tag` is unchanged: they are durable identity, not
  source location.
