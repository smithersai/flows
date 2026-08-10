# @smthrs/database

## [Unreleased]

### Changed

- A `write` nested inside another `write` now joins the enclosing transaction
  as a savepoint without its own retry; only the outermost transaction replays
  a transient conflict.
- The retry classifier follows `cause` chains, so a domain error wrapping a
  transient SQL failure keeps the outermost transaction replaying.

## [0.1.0] - 2026-08-05

### Added

- Added the thin Effect SQL service, Node SQLite layer, in-memory test layer, and bounded transient-write retry policy.
