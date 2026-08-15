# /harness

## [Unreleased]

### Fixed

- Journaled the turn-boundary steering drain through the new `EngineLike.record` boundary in both `CellTurn` and the legacy `Turn` loop. The drain consumes host queue state, so it is a nondeterministic read: left unjournaled, a run resumed after a park or crash drained an already-drained queue, rebuilt a different context than the original attempt, re-keyed every later sealed step, and could re-execute irreversible effects. The drain is now recorded once per frame boundary and replayed verbatim on re-execution.

### Added

- Added `EngineLike.record` with `RecordBoundary` and `BoundaryIdentity`: the port's generic journaled-boundary operation for nondeterministic controller reads, and `Steering.DrainRecord`/`Steering.drainRecord`, the serializable projection of a turn-boundary drain that the controller journals.

- Added the built-in agent harness for translating dynamic nodes into sealed model steps and child plans.
- Added harness-owned, call-correlated child progress events streamed from the
  engine splice boundary before ordered child settlement.
- Added `Cell`: the cell contract — agent-authored source with a stable digest,
  the serializable `continue` / `complete` / `park` transition a cell returns,
  typed outcomes for a cell that threw or never produced a transition, the
  cell-visible flow projection, and the identity carried by every call made
  inside a cell.
- Added `Sandbox`: the deterministic script sandbox port, whose only effectful
  primitive is flow invocation against the frame's capability-narrowed catalog,
  plus `layerRestricted`, a dependency-free binding that denies ambient time,
  randomness, network, filesystem, process, and module access by identifier.
- Added `QuickJSSandbox`: the QuickJS-WASM binding, a genuinely separate
  JavaScript realm that runs the same single-file build on Node and in a
  browser and can enforce declared memory and step limits.
- Added `CellTurn`: the cell-first controller. It seals one model step per
  frame, recovers the cell, runs it, resolves each of its calls as its own
  durable boundary, and continues, completes, or parks from the transition the
  cell returned rather than from provider tool calls.
- Added `EngineLike.call`, the one-call-at-a-time durable bridge that supports
  data-dependent calls inside a cell.
- Added cell events to `AgentEvent`: `CellProduced`, `CellCallStarted`,
  `CellCallSettled`, `CellSettled`, and `TransitionApplied`.
- Added `CellCalls`: registry-backed resolution for the flow calls a cell makes,
  so `ctx.call` reaches a flow `@smthrs/registry` actually discovered under
  the `flow.ts` -> `flow.mdx` -> `SKILL.md` precedence. Module bodies are bound
  by the host, markdown bodies are rendered and handed to a prompt runner, and
  every resolution refusal is a catchable call failure rather than a run
  failure.
- Added `FlowBinding`: the one executable-flow contract. A `Binding` pairs an
  ordinary flow declaration with its handler, decoding cell input through the
  flow's input schema and validating the handler's output back into
  serializable JSON; a `Source` produces bindings, possibly lazily; a `Catalog`
  composes ordered sources and refuses two implementations under one name; and
  `FlowBinding.registry` discloses a catalog through the ordinary
  `Registry.Registry` contract with file-discovered entries keeping precedence.
  Correctable failures become catchable `Cell.CallResult` failures while
  permission, abort, and suspension failures stay in the typed error channel.
- Added `CellCalls.Options.catalog`, so a bound implementation answers a call
  only when its declaration digest matches the one disclosure published.

### Changed

- Moved the superseded provider-tool-call loop out of `Harness` and into
  `LegacyHarness`. `Harness` now carries only the neutral adapter contract and
  its stub, which is what foreign CLI adapters implement; the cell path is the
  documented default. No provider request or tool event schema was removed.

### Fixed

- Emitted the `CompactionSettled` event a compaction had always constructed
  material for but never published, so replay no longer rebuilds the
  uncompacted transcript and re-crosses the same overflow threshold.
- Declared `toolChoice` on `ModelRequest` instead of attaching it to a sealed
  request with `Object.assign` after construction.
- Branched context-overflow recovery on the provider adapter's typed
  `context_overflow` code instead of re-deriving it from a regular expression
  over the provider code and message. Recovery no longer depends on prose no
  provider promises to keep stable, and it no longer silently stops working for
  a provider whose wording the harness had not seen.

- Retained inactive deferred tool definitions so additive activation can render native references and complete fallback lists.
- Bounded turns with landing frames, used resolved model context capacity for
  compaction, supplied a stable summary instruction, and kept invalid
  compaction prefixes in a typed error channel.
- Made queue promotion durably consumptive, filtered both disclosure and
  elaboration by seat visibility, and plumbed recorded envelope, environment,
  and self-documentation declarations into the seven-section system prompt.
- Ignored progress emitted after a child settled and kept transient progress
  out of transcript projection.

## [0.1.0]

### Added

- Initial release.
