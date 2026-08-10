# @smthrs/pty

## [Unreleased]

### Added

- Split the `Pty` contract, `PtyError`, and the Node, Bun, and browser adapters
  out of `@smthrs/host` into their own package. The tag key `flows/host/Pty` and
  the error `_tag` `flows/host/PtyError` are unchanged: they are durable
  identity, not source location.
