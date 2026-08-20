# /model

## [Unreleased]

### Changed

- Endpoint and built-in route constructors now return `Result`, making
  validation failures explicit instead of throwing. Request lowering and
  protocol state-machine failures now remain in typed Effect failure channels.

### Added

- Added Schema-first Anthropic Messages and OpenAI Responses protocols, deterministic route composition, deferred tool loading, typed streaming events, and a redacting request executor.
- Added `ToolChoice` and the optional `ModelRequest.toolChoice` field, so a
  frame that declares no tools can say so in the schema rather than have the
  value attached to the request afterwards.
- Added the `context_overflow` `ModelErrorCode` and `ModelError.isContextOverflow`,
  so a request that did not fit the model's context window is a typed code
  rather than a phrase a consumer has to re-parse. The Anthropic Messages and
  OpenAI Responses protocols and the shared request executor now classify their
  own overflow vocabulary ahead of the generic `invalid_request` branch.

### Fixed

- Preserved OpenAI reasoning item references across tool-call continuations and honored initially deferred tool declarations in native and fallback lowering.
