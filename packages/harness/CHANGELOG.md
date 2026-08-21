# /harness

## [Unreleased]

### Changed

- `Cell.extract` now runs **every** fenced `cell` block of one reply as one program instead of keeping only the last, and returns `Extracted` (`{ source, blocks }`) rather than bare `Source`. Distinct blocks are concatenated in reply order, so a value bound in one is bound for the ones after it and the first `return` ends the frame; a byte-identical repeat of a block is dropped rather than concatenated. `AgentEvent.CellProduced` carries the reply's block count. Wave-10 django wrote a near-par seven-block program in one reply and the harness executed block seven — the imagined completion — against a tree where blocks one to six had never run: empty patch, run over in two frames. Replaying all five wave-10 journals through the new extraction: 2 of 91 replies were multi-block (7 blocks discarded), the astropy one is a duplicated block that de-duplication now runs unchanged, and the django one is a redeclaration that becomes a `compile_failed` the controller annotates with the block count instead of a wrong completion.

- Moved the frame's state section out of the system context and into one trailing user message after the transcript, so the whole stable span — contract, catalog, task, registry — is a byte-identical prefix for the life of a run and a provider's prefix cache covers all of it. Two graded instances ran at 38% and 69% cached input with the volatile block sitting between the teaching and the transcript.

### Added

- Added `Cell.Continue.render`: a `continue` transition may name durable-state keys the next frame must see rendered in full. Named keys are printed in the state section instead of their roster line, bounded at 4,096 bytes each (over-bound values keep their first and last 2,048 bytes with the elision stated) and at 8 keys per transition. Replaying the wave-10 journals, 21 of 91 frames were zero-call frames whose only work was copying state into `context`, and all 86 keys they read were already held by the previous transition's own state — every one of those frames was reachable by `render`.

- Added `CallLedger`, the run's automatic ledger of settled calls, rendered in every frame's state section: ordinal, flow, the first targeting term of the input, ok or failed, and a structural digest of the result (counts, byte lengths, exit codes — never payloads), bounded to the 30 most recent. A call result was previously invisible unless the blind-authored cell that made it happened to copy it, which is what manufactured the zero-call rehydration frames; the ledger also survives a raised frame, so settled work is no longer lost with the throw.

- Added `NarrowedCheck.lex`, the document-order view of the lexer `NarrowedCheck.terms` already sorted, so `CallLedger` asks its positional question of the same lexer rather than copying the separator.

### Removed

- Removed `Steering.drainBoundary`. Its only caller was the deleted legacy
  `Turn`; `drainAtClose` and `promoteAtIdle`, the two operations it composed,
  remain.

### Fixed

- Bounded each host flow call independently of the cell's 15-minute backstop.
  An over-budget call now returns a catchable, typed
  `FlowCallTimeoutError` with a model-facing narrowing instruction, while the
  cell keeps running and may retry a smaller call.

- Stopped charging a settled flow call's duration to the cell's compute clock; a new `totalMs` ceiling (default 15 minutes) backstops a call that never settles. 57 of the 62 rejected frames in the first SWE-bench benchmark were legitimate long test runs hitting the old 30-second wall clock.

- Journaled the turn-boundary steering drain through the new `EngineLike.record` boundary in `CellTurn`. The drain consumes host queue state, so it is a nondeterministic read: left unjournaled, a run resumed after a park or crash drained an already-drained queue, rebuilt a different context than the original attempt, re-keyed every later sealed step, and could re-execute irreversible effects. The drain is now recorded once per frame boundary and replayed verbatim on re-execution.
- Accepted explicit JSON `null` values for optional top-level flow input fields by retrying rejected input without those fields, while preserving the original rejection when the remaining input is invalid and preserving `null` for schemas that accept it.
- Restored `FlowProjection` construction without an explicit input document by defaulting the field to `Option.none()`.

### Added

- Added `TruncatedOutput`, the run's ledger of output a flow returned after cutting it, and wired it into the cell call boundary: a call that declares writes and carries a string byte-identical to an earlier truncated capture is refused as a catchable `CallResult` failure naming git checkout/restore as the way to restore a file. The ledger is durable controller state (`CellTurn.State.truncatedOutputs`, digests only, sixteen most recent), so a fragment stashed in `state` is still recognised a frame later. A benchmark instance lost this way: `git show <base>:src/_pytest/python.py` returned 30,000 bytes of a 54,000-byte module with `stdoutTruncated: true`, the cell wrote exactly those bytes back over the file, and the mangled tail was the graded patch.

- Taught the cell contract that a result flagged truncated is a fragment: restore a file from git with git checkout or git restore, never by routing file content through captured stdout.

- Made the truncation ledger's sixteen-entry bound count distinct payloads. A repeated call returns the same bytes and so the same digest, and the guard compares digests, so each repetition was taking a slot it added nothing to: seventeen identical `git show` restores evicted every other fragment the run had been handed and re-opened the hole. The run this guard exists for is exactly a run that repeated one restore frame after frame.

- Added the run-start `DisciplineArmed` event, recording the read-only and
  frame caps and every effective sandbox limit before the first frame runs.

- Added the opt-in read-only frame cap (`CellTurn.make({ readOnlyCap })`, default `CellTurn.defaultReadOnlyFrames` = 12 for task runs). A frame that made no call declaring a write extends the run's read-only streak; at the cap the controller demands a write or a typed `justification` on the next transition, and at twice the cap the run stops with `HarnessError` code `read_only_cap` instead of reporting work it never did. A justification is recorded and buys `readOnlyCap` quiet frames without resetting the counter. One benchmark instance read for all 100 frames, made 132 calls with zero edit attempts, and completed claiming the fix was implemented.

- Added `Cell.Continue.justification` to the cell protocol, and taught it in the cell contract.

- Added `AgentEvent.ModelSettled.durationMillis`: the wall-clock duration of one sealed model call, read from the injected clock, so a benchmark can measure latency per call rather than only per run.

- Exposed the previous frame's returned state to the cell as the frozen `ctx.state` binding in both sandbox bindings, and taught the contract to treat it as working memory.
- Rendered large states in the system context as a key roster instead of full JSON; the full value lives in `ctx.state`.
- Preserved a raised frame's completed call results in the correction feedback so the next cell reuses them instead of redoing the work.
- Echoed the received arguments in a schema-refused call's message so one corrected cell fixes the input.

- Taught the cell contract that FlowCallError is worth catching in-cell and that long-running calls are safe to await.

- Added `EngineLike.record` with `RecordBoundary` and `BoundaryIdentity`: the port's generic journaled-boundary operation for nondeterministic controller reads, and `Steering.DrainRecord`/`Steering.drainRecord`, the serializable projection of a turn-boundary drain that the controller journals.
- Carried projectable flow input and output schemas as inline JSON Schema documents in binding descriptors, projected input documents into `ctx.flows`, and rendered them in the cell catalog.

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

### Removed

- Removed the superseded provider-tool-call loop and the modules that existed
  only to serve it: `LegacyHarness`, `Harness`, `Turn`, `Tools`, `Assemble`,
  `AgentStep`, `Elaborate`, `FlowTool`, and `Visibility`. The production agent
  loop is the cell path — `Cell`, `CellTurn`, and `CellCalls` — which decides
  continuation from the transition a cell returns rather than from provider
  tool calls. Foreign CLI adapters, when they return, implement the `Agent`
  service in `@smthrs/agent` instead of the neutral `Harness` contract this
  package used to declare.

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
