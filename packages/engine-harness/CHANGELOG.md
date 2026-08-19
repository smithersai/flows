# @smthrs/engine-harness

## [Unreleased]

### Added

- Made agent reasoning effort configurable: the flow's `effort:` frontmatter wins, then the host's `Options.reasoningEffort`, then the `high` default.

- Defaulted every executor-launched run to medium reasoning effort; an unset effort left the model with near-zero thinking budget.

- Added durable `control.agent.*` trail projections with occurrence timestamps
  and bounded failure causes for executor runs.
- Added workspace-relative file boundary conversion for cell calls.
- Added transient sealed-model retries while preserving non-retryable model
  failures.

## [0.1.0] - 2026-08-05

### Added

- Initial release.
