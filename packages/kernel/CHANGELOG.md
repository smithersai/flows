# @smithers/kernel

## [Unreleased]

### Added

- Added the effect-aware capability model, monotone attenuation, journaled grant store, and mandatory decoration of the original Host and Effect service tags.
- Added tier-preserving grant validation, canonical filesystem confinement, single-hop HTTP transport enforcement, browser-bundle coverage, and dual ESM/CJS package artifacts.

### Fixed

- Switched Host integration to its current public service subpaths and made the browser root entrypoint Node-free.
- Corrected configured-policy last-match-wins evaluation, journaled one-call grants, and resumed every pending waiter covered by run grants.
- Added plan-digest-bound run and remembered envelopes, same-run grant replay, trusted journal envelope validation, and duplicate-free resume.
- Preserved grant-store lifecycle failures in the typed stable-code channel and emitted identity-safe non-bundled CJS modules.
