# @smthrs/jj

## [Unreleased]

### Added

- Split the `Jj` contract, `JjError`, and the Node, Bun, and browser adapters
  out of `@smthrs/host` into their own package. The tag key `flows/host/Jj` and
  the error `_tag` `flows/host/JjError` are unchanged: they are durable
  identity, not source location.
