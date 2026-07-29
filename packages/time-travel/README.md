# @flows/time-travel

Durable, browser-safe replay and fork primitives over public journal contracts.
Rewind archives a single parent journal suffix atomically; attached child events
share that sequence and are therefore included, fixing Smithers' child-blind
truncation behavior. Forks copy a prefix with deterministic event identifiers,
share the global sealed cache, and never mutate the parent.

This package follows Effect service/tag/layer conventions. The SQL store uses
portable scalar SQL and owns its migration; it does not depend on journal internals.

`EffectBoundary.guard` journals intended and terminal evidence around tiered
effects. `EffectHandlerRegistry` and `Compensation` classify and reverse
crossed effects. `Recovery` resumes interrupted audits and `Retry` applies
bounded retry policy.

See the [package reference](../../docs/reference/time-travel.md).
