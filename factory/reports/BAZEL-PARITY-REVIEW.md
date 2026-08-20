# Bazel Skyframe parity review

Generated 2026-08-19T19:23:57.853Z by five parallel claude-fable-5 agents
run through the flows library itself (factory/flows/bazel-review.ts).

## packages/keys

# Review: `@smthrs/keys` vs Bazel Skyframe

Date: 2026-08-19. Scope: `flows/packages/keys` (source and tests), compared against
`reference/bazel/src/main/java/com/google/devtools/build/skyframe`.

## Scope note

`@smthrs/keys` is deliberately a leaf: one schema, `Key`, that turns a canonical JSON
value into `key1_<sha256>` (`keys/src/Key.ts:60-75`). It is the SkyKey-identity layer
of the system, not the evaluator. Of the evaluator invariants named for this review,
none is implemented in this package, and each has a Skyframe counterpart the `engine`
review should be held against instead:

- Node dirtying and change pruning: `DirtyBuildingState.java`.
- Graph/evaluation versions: `Version.java`, `IntVersion.java`, `NodeVersion.java`.
- Error bubbling and transitive error propagation: `ErrorInfo.java`, `AbstractParallelEvaluator.java`.
- Cycle detection: `CycleDetector.java`, `SimpleCycleDetector.java`.
- Dependency bookkeeping and invalidation: `GroupedDeps.java`, `ReverseDepsUtility.java`, `InvalidatingNodeVisitor.java`.
- Partial re-evaluation: `PartialReevaluationMailbox.java`.
- Interruption: `SchedulerException.java`, `NodeEntryVisitor.java`.

Those areas are out of scope here because they live in `packages/engine` and
`packages/engine-store`. This report covers the invariants `keys` does own: key
identity, namespace separation, scheme versioning, and memoization-reuse correctness
of the digest itself. Where a finding needs call-site evidence, it cites the
consumers (`plan`, `engine`, `engine-store`, `flow`) that mint keys through this
package.

## Findings, ranked

### 1. Medium (design gap): the key primitive carries no function-identity namespace, and untagged minting sites already exist

Skyframe's core identity invariant is that a key is a pair. `SkyKey.java:25` states it
directly: "A SkyKey is effectively a pair (type, name)". The type half is structural:
`SkyKey.functionName()` is an abstract method (`SkyKey.java:42`), it participates in
`equals`/`hashCode` (`AbstractSkyKey.java:39-41`, `54-55`), and the names themselves
come from a checked interned registry. `SkyFunctionName.java:61-69` runs a
`Preconditions.checkState` on every registration, so two subsystems that pick the same
name with different semantics fail loudly at construction time. Cross-function
collision is impossible by construction.

Our `Key` decodes `Schema.Unknown` with no required namespace field
(`keys/src/Key.ts:60-62`). Namespace separation is a convention that each consumer
implements by hand-picking a `kind` string. The current census:

| Package | Site | Tag |
| --- | --- | --- |
| plan | `plan/src/StepKey.ts:302, 321, 492` | `content`, `ordinal`, `input-value` |
| engine | `engine/src/FlowEngine/ActionKey.ts:171-172` | `run`, `cache` |
| flow | `flow/src/Action/StepIdentity.ts:134, 160` | `declaration`, `invocation` |
| engine-store | `engine-store/src/StepBoundary.ts:845, 870-871` | `tree-artifact`, `diff-identity` |
| engine-store | `engine-store/src/internal/ActionPersistence.ts:614-615` | `cache-generation` |
| flow | `flow/src/Interpreter.ts:155-161` | none (raw payload, then a bare 4-element array) |
| flow | `flow/src/Flow/ExecutionIds.ts:64-65` | none (raw encoded payload) |

Two facts follow from that table:

- The tag vocabulary is spread across four packages with no registry, no shared
  constant module, and no test that asserts the strings are pairwise distinct or that
  a given tag always fronts the same material shape. Today they happen to be
  distinct. Nothing keeps them distinct; the next call site that picks `content` or
  `cache` for a different shape creates silent aliasing in whichever store both keys
  reach, and the symptom is a stale hit, not a failure.
- Two sites mint keys with no tag at all. I traced both and neither digest currently
  reaches a `key1_`-keyed store: `Interpreter.ts:155-156` produces intermediates that
  are folded into a child execution id and stripped of the prefix
  (`Interpreter.ts:162`), and `ExecutionIds.ts:64-65` feeds a second bare-hex
  derivation (`ExecutionIds.ts:84`). So this is a missing invariant, not an active
  collision. But the safety argument is "I inspected every call site and the
  untagged digests stay intermediate", which is exactly the kind of argument
  Skyframe's design makes unnecessary.

Recommendation: give the package the structural half of the SkyKey pair. Export a
tagged constructor (for example a `Key.namespaced(kind)` schema factory that folds a
declared kind into the hashed document), keep the raw `Key` decode internal or
test-only, and add one repo-level test that greps for `decodeUnknownEffect(Key)`
outside the sanctioned wrapper, plus one that registers every kind string in a single
table the way `SkyFunctionName`'s interner does.

### 2. Medium-low (bug in the stated contract): the version marker promises forward decodability the pattern cannot deliver, and accepts never-minted versions today

The docblock says a future derivation gets `key2_` "and both remain decodable, so a
stored key never becomes ambiguous" (`keys/src/Key.ts:12-14`), and the pattern
comment repeats that a pattern anchored to one version "would refuse exactly the keys
the marker promises to keep decodable" (`keys/src/Key.ts:27-31`). The test at
`keys/test/Key.test.ts:136-143` enshrines the promise.

The pattern is `/^key[1-9][0-9]*_[0-9a-f]{64}$/` (`keys/src/Key.ts:36`). It accepts
any version number but pins every version to exactly 64 lowercase hex characters,
which is to say: to SHA-256's shape. The most likely reason a `key2_` scheme would
ever exist is a digest change (truncation, SHA-512, BLAKE3), and any such scheme
produces keys this validator refuses. The pattern keeps the promise only for future
schemes that change the derivation without changing the digest width and alphabet,
which is the least likely kind of future scheme.

The converse problem is worse in the present: `key2_<any 64 hex>` validates today
even though no scheme has ever minted a `key2_` value. The neighbouring test justifies
rejecting `key0_` on exactly the ground that it is "not [a version] the scheme has
ever minted, so accepting [it] would let a corrupted value masquerade as a key"
(`keys/test/Key.test.ts:145-152`). That reasoning applies verbatim to `key2_` through
`key999..._`. The two tests encode contradictory policies and both pass.

Skyframe has no analog of a self-describing serialized key string, and that is
instructive: version tolerance there is handled by explicit version objects the
evaluator compares (`Version.java`, `IntVersion.java`, `NodeVersion.java`), never by
accepting an unknown future form and hoping it stays well-shaped. Recommendation:
validate only versions the code can interpret (today, `key1_` exactly), and let the
storage-reading edge classify unknown markers explicitly (readable-but-foreign versus
corrupt) when a second scheme actually ships. Delete or invert the
`key2_`-acceptance test when doing so.

### 3. Low (API gap): the validated storage codec is effectively unreachable, so stores fall back to unvalidated strings

`KeyValue`, the pattern-checked branded string, is `@private`
(`keys/src/Key.ts:25-38`). The only exported symbol is the one-way derivation. A
consumer that wants to validate a key it read from storage must know to write
`Schema.toType(Key)`, and the only call sites of that incantation in the tree are this
package's own tests (`keys/test/Key.test.ts:25, 142`). Production stores type key
columns as plain strings instead: `engine-store/src/PlanScheduler.ts:341` persists
`stepKeyDigest: Schema.NonEmptyString`. That defeats the invariant `@smthrs/crypto`
states for digests, that an identity "crosses the journal and the cache and must
compare byte-for-byte wherever it is read" (`crypto/src/Sha256.ts:9-11`): a corrupted
or truncated key column round-trips unnoticed until it simply never matches.

There is also a misuse footgun in the same gap: the exported direction, decode, is
total on strings, so "validating" a stored key by decoding it silently re-hashes the
key string into a different, perfectly well-formed key. No call site does this today;
nothing but convention prevents it. Skyframe does not have the hazard because keys
are typed objects end-to-end and re-wrapping is an explicit, documented act
(`AbstractSkyKey.java:20-22` covers even the key-inside-key case).

Recommendation: export the validated string schema (for example `Key.FromStored` or
`Key.Schema`) and use it in store row schemas; document that decode derives and never
validates.

## Areas checked and found sound

- Canonicalization is RFC 8785-correct where key identity depends on it: member sort
  by UTF-16 code units (`canonical/src/internal/canonicalize.ts:72`), ECMAScript
  number serialization (`canonicalize.ts:56`), lone-surrogate refusal at the one point
  that sees every emitted string including `toJSON` output (`canonicalize.ts:28-42`),
  cycle refusal (`canonicalize.ts:57-59`), and a fail-closed `JSON.parse` backstop
  that turns any serializer gap into a decode failure rather than a divergent digest
  (`canonical/src/Canonical.ts:67`).
- The deliberate erasures (`-0` to `0`, dropped `undefined` members, `undefined`
  array elements to `null`) are documented as contract and pinned by tests
  (`keys/test/Key.test.ts:80-102`), and the property test asserts injectivity exactly
  up to canonical equality (`keys/test/Key.property.test.ts:45-86`). This is the
  right collision contract for a content key.
- Injection resistance holds: structure is inside the digest, and the classic
  concatenation witnesses are tested (`keys/test/Key.test.ts:104-118`). The one
  concatenation-based derivation in a consumer (`flow/src/Flow/ExecutionIds.ts:84`,
  `` `${flow._tag}-${key}` ``) is injective only because the suffix is a fixed-shape
  key string; it would be more robust folded through `Key`, but it is outside this
  package and not currently a collision.
- Cross-release key stability is golden-pinned (`testing/test/KeyGoldens.test.ts:11-13`),
  which is the correct guard for cache identity across refactors.
- The digest-not-argument design is coherent. A Skyframe key must carry its preimage
  because a dirtied node re-runs from `SkyKey.argument()` (`SkyKey.java:44-46`); a
  `Key` can address work but never re-produce it. The system accounts for this: plan
  materials are retained above the key (`plan/src/KeyMaterial.ts`,
  `plan/src/StepKey.ts:337-379`), so the engine dispatches from material and uses
  keys purely as addresses. The invariant to protect going forward is that no engine
  path ever needs to enumerate, dirty, or re-evaluate from a bare `Key`; if one
  appears, it needs a key-to-material side table by design, not by accident.


## packages/engine

# `@smthrs/engine` vs Bazel Skyframe — review findings

Reviewed: `flows/packages/engine/src` (all files) and its tests, against
`reference/bazel/src/main/java/com/google/devtools/build/skyframe` (read-only).
Date: 2026-08-19.

## Scope and mapping

`@smthrs/engine` is not a Skyframe-shaped evaluator. It is a Temporal-shaped
durable flow engine (replay a program body against memoized step outcomes)
with one Skyframe-shaped seam: action identity and the cross-run cache key
(`ActionKey.ts`, mirroring `SkyKey = (functionName, argument)`). The Skyframe
invariants that transfer are therefore: memoization and reuse correctness,
in-flight deduplication, cycle detection, wake-signal delivery, interruption
never committing partial state, and error caching semantics. Version-based
dirtying and change pruning are deliberately replaced by key-based
invalidation (a changed read-set digest is a different key), with the
store-side re-measure living in `engine-store` — the test suite states this
explicitly (`test/IncrementalInvalidation.test.ts:10-15`). The findings below
are ranked; documented design decisions that still violate a Skyframe
invariant are flagged as such.

---

## Finding 1 (HIGH): a wake signal delivered while the round fiber is still live is silently dropped, and re-signaling is a no-op

**Our code.** `layerMemory.resume` refuses to act when the round fiber exists
but has not settled:

- `src/FlowEngine/layerMemory.ts:76-84` — `resume` polls the round fiber and
  returns early when `state.fiber && !exit` (fiber live).
- `src/FlowEngine/layerMemory.ts:301-307` — `deferredDone` stores the exit and
  calls `resume` exactly once; line 304 (`if (deferredResults.has(id)) return
  Effect.void`) makes every subsequent signal for the same deferred a no-op
  that does not even attempt a resume.
- `src/FlowEngine/layerMemory.ts:308-318` — `scheduleClock` funnels through
  the same `deferredDone`, with `FiberMap.run(..., { onlyIfMissing: true })`,
  so a timer wakeup has the same single-shot delivery.

**The race.** An action checks `deferredResult` (finds none), begins
suspending; the suspension unwind (finalizers, `waitForZero` latch in
`flow/src/Flow/Runtime.ts:104-146`) takes multiple scheduler turns. If
`DurableDeferred.succeed` / a clock fire lands in that window, `resume` sees a
live fiber and drops the wakeup; the round then settles `Suspended` and
nothing ever re-drives it. For an awaited execution the caller's polling loop
(`make.ts:261-290`) eventually rescues it — at backoff latency, and only until
the `suspendedRetryPolicy` expires or exhausts, at which point the run dies
(`make.ts:268-278`) even though its wake condition was already met. For a
`discard: true` execution there is no polling loop and the run parks forever.

**Skyframe invariant.** A dep-completion signal is recorded in the parent's
node state, never delivered to a live thread: `NodeEntry.signalDep`
(`NodeEntry.java:415`) counts signals under the entry's lock, and the
evaluator schedules the parent iff it is ready; an in-flight parent that
finishes its evaluation pass re-checks dep completeness. A signal cannot be
lost, and signaling twice is harmless. Our engine delivers the signal against
live-fiber state and discards it.

**Fix shape.** Record a `pendingWake` bit on `ExecutionState` when `resume`
finds a live fiber, and re-run `resume` from the round fiber's settlement tap
(the same place the parent tap lives, `layerMemory.ts:120-125`) — the
in-memory equivalent of `signalDep` counting.

---

## Finding 2 (HIGH): no cycle detection anywhere in the package — a parent-chain cycle deadlocks silently, against a contract that declares the typed error

**Our code.**

- `src/FlowEngine/Encoded.ts:53-73` — the `execute` contract declares
  `FlowRuntime.FlowCycleDetected` in its error channel.
- `src/FlowEngine/layerMemory.ts:160-187` — `execute` joins an existing
  execution's fiber (`Fiber.join(state.fiber!)`, line 187) with no ancestry
  check. A flow whose body executes its own execution id — directly or
  through any transitive chain of subflow calls — makes the body fiber join
  its own ancestor round fiber: a permanent, silent deadlock. `grep -rn
  cycle packages/engine/src packages/engine/test` finds no detection code and
  no test.
- `README.md:73` claims "Registering a flow that executes itself transitively
  fails with `FlowCycleDetected`." Nothing in this package (nor in
  `@smthrs/flow` registration) implements a registration-time check; the only
  real detection lives in `engine-store`
  (`flow/src/FlowRuntime/FlowCycleDetected.ts:18-23` documents
  `DurableEngineState.recordRunParent` walking the persisted parent chain).
  The README documents behavior the package does not have.

**Skyframe invariant.** A key that transitively depends on itself must
terminate the evaluation with `CycleInfo`, never hang:
`SimpleCycleDetector.java:39-42` ("Depth-first implementation of cycle
detection after a ParallelEvaluator evaluation has completed") and its
path-on-stack algorithm at `SimpleCycleDetector.java:84-99`. Skyframe treats
join-of-in-flight (our line 187, the legitimate dedup case) and
ancestor-join (a cycle) as different cases precisely because the graph walk
can tell them apart; `layerMemory` keeps no ancestry to walk.

**Consequence.** The same flow program fails with a typed, recoverable error
on the durable engine and hangs forever on the in-memory one — the layer
recommended for "tests and local development" is where the hang is most
likely to be hit and least diagnosable. An in-process parent-chain walk over
`ExecutionState.parent` (already stored, `layerMemory.ts:54,181`) is O(depth)
and would restore contract parity.

---

## Finding 3 (HIGH): `layerMemory` memoizes an interrupted attempt as a settled outcome and replays the interruption to later dispatches

**Our code.** `layerMemory.actionExecute` records **every** exit of a
dispatch and replays whatever it finds:

- `src/FlowEngine/layerMemory.ts:265-268` — `Effect.onExit((exit) => {
  state.exit = exit; ... })` records failure exits too.
- `src/FlowEngine/layerMemory.ts:237-242` — a recorded exit that is not
  `Success(Suspended)` is replayed verbatim (`return yield* exit`).

Per `flow/src/Flow/Runtime.ts:70-75`, a dispatch interrupted while
`instance.interrupted === false` — a lost `Effect.race`, an `Effect.timeout`
around a dispatch, both named as normal occurrences in this package's own
concurrency-guard comment (`make.ts:565-570`: "an interruption (a lost race,
a timeout)") — settles as `Exit.Failure` with an interrupt-only cause. That
exit is memoized under `(key, attempt)`. Every later dispatch of the same key
at that attempt replays the interruption instead of executing: the new fiber
is spuriously interrupted, which the round-level `intoResult` then
misclassifies (interrupt-only cause, `interrupted === false`, not suspended →
`Effect.failCause`, `Runtime.ts:72-74`), failing the round fiber and turning
`poll` into a defect (`layerMemory.ts:291-293`).

**The package's own durable contract says otherwise.** The test driver that
documents intended driver behavior journals settlements only:
`test/DurableLogEngine.ts:233-238` — "Only settlements are journaled: a fiber
killed mid-attempt leaves no outcome row" (`if (Exit.isSuccess(exit))
log.actionOutcomes.set(...)`). `layerMemory` diverges: it persists the
mid-attempt kill.

**Skyframe invariant.** Interruption never commits: "In case of an interrupt,
the work queue is discarded, and the in-flight set is used to remove
partially computed values" (`AbstractParallelEvaluator.java:82-84`). An
interrupted node stays not-done and re-evaluates next time; interruption is a
circumstance, not a value.

**Fix shape.** Mirror `DurableLogEngine`: record only `Exit.Success` (a
`Flow.Result` — completion, suspension, handoff); let an interrupted or
harness-defect exit leave `state.exit` unset so the next dispatch re-executes.

---

## Finding 4 (MEDIUM): the trampoline stalls for fire-and-forget executions, and post-handoff rounds drop the parent edge

Two related lineage-driving gaps; the trampoline is followed only inside the
awaiting caller's loop (`make.ts:201-291`).

**4a. `discard: true` + handoff = stalled lineage.** `make.ts:184-187`
returns immediately after starting round 0 for a discarded execution, never
entering the handoff-following loop. In `layerMemory` nothing else follows a
handoff: the settlement tap resumes only the parent and only on `Complete`
(`layerMemory.ts:120-125`), and `resume` explicitly refuses to re-drive a
handed-off round (`layerMemory.ts:78-84`) on the premise that "one that
handed off has already opened the next round" — false when no caller loop
exists. A fire-and-forget flow whose body ends in `Other.to(...)` runs round
0 and stops; `poll` answers `Handoff` forever, and even an explicit
`engine.resume` cannot advance the lineage. No test covers discard+handoff
(the only trampoline discard test, `test/Trampoline.test.ts:351-387`, uses a
non-handoff flow).

**4b. Rounds ≥ 1 lose the parent link.** When a child flow (executing under a
parent) hands off, the continuation passes `parent: undefined`
(`make.ts:247-253`, the literal `undefined` at line 252). The prompt
cancellation path survives via the mutable `roundExecutionId` finalizer
(`make.ts:141-160`), but the *completion wakeup* edge does not: in
`layerMemory` the post-handoff round's `state.parent` is `undefined`, so when
that round later completes, the parked parent is not resumed
(`layerMemory.ts:121`). A discard-launched parent whose child handed off and
then suspended is never woken after the child completes — the same
lost-wakeup family as Finding 1, but structural rather than racy.

**Skyframe invariant.** Evaluation-driving state lives in the graph, not in a
caller's stack frame: a parent is signaled by its deps through
`NodeEntry.signalDep` (`NodeEntry.java:415`) regardless of who requested the
evaluation, and reverse-dep pointers are maintained as first-class graph
state (`InvalidatingNodeVisitor.java:53-60` states the invariant that reverse
dep pointers must always point to existing nodes). Our engine's equivalent
edge (execution → parent) exists but is dropped across handoff rounds and
unused for handoff settlements.

---

## Finding 5 (MEDIUM): no in-flight deduplication for same-key sealed dispatches — the key double-executes, and the `nondeterministic` conflict policy is unimplemented in-memory

**Our code.** A sealed action with an idempotency key bypasses the
concurrent-dispatch refusal by design (`make.ts:561`), on the theory that the
pure cache key makes concurrent dispatches safe. But `layerMemory` has no
in-flight join: two concurrent dispatches of the same key both find
`state.exit === undefined` and both execute (`layerMemory.ts:236-244`), then
race their `onExit` writes — last write wins (`layerMemory.ts:265-268`).
`test/EngineEdgeGaps.test.ts:264-308` pins this as intended for the memory
engine ("two concurrent runs of the same keyed action both execute, then
replay after settling"). The `Encoded` contract also documents a conflict
policy the in-memory driver ignores entirely:
`Encoded.ts:33-34` — `nondeterministic` "Allows a cache put race to retain
the **first** row without failing this run" — implying a deterministic
action's conflicting put should fail the run, and that first-wins is the
retention rule. `layerMemory` does neither: no conflict check, last-wins.

**Skyframe invariant.** A key is computed at most once per evaluation: a
second requester of an in-flight node gets `ALREADY_EVALUATING` and is
signaled on completion instead of re-computing
(`NodeEntry.java:40-56`, `DependencyState.ALREADY_EVALUATING`). For a tier
whose whole point is "exactly-once by key" (the sealed tier carries
side-effecting builds in the incremental-invalidation suite), double
execution inside one process is a duplicated side effect the key was
supposed to prevent.

**Fix shape.** Track in-flight sealed keys in the `actions` map (a promise/
latch per key) and join, mirroring `ALREADY_EVALUATING`; on settle, apply the
documented first-wins/conflict rule instead of the racing overwrite.

---

## Finding 6 (MEDIUM): cached failures have no transience — a transient error poisons a sealed key forever

**Our code.** A sealed key's recorded typed failure replays on every future
run with no re-execution, pinned as intended by
`test/IncrementalInvalidation.test.ts:182-188` ("A later engine instance
replays the RECORDED failure for the same key"). The failing action in that
test is literally an input-read failure (`"input-unreadable"`) — the
canonical *transient* error class. Nothing in the `Encoded` seam
(`Encoded.ts:116-122`) or the key material (`ActionKey.ts:115-197`) lets an
implementation or a driver mark a failure as non-cacheable; the only escapes
are a changed read-set digest or a changed cache environment. `RetryPolicy`
handles retries within a run (`make.ts:470-511`), but once attempts exhaust,
the per-attempt failure rows replay across every future run and re-derive the
same exhaustion.

**Skyframe invariant.** Bazel splits error persistence by transience:
`ErrorTransienceValue.java:18-21` — a value that "is not equal to anything,
including itself, in order to force re-evaluation," depended on by every
transiently-failed node so the next evaluation retries it; `ErrorInfo`
tracks `isDirectlyTransient` / `isTransitivelyTransient`
(`ErrorInfo.java:32-71`). Persistent errors replay; transient ones do not
outlive the evaluation.

**Assessment.** Replaying recorded failures is the right default for a
deterministic step, but the seam needs a transience channel (per-error or
per-action: "record this failure for this run only / not at all"). Without
it, one flaky network read permanently poisons a cross-run cache key until a
human changes an input digest.

---

## Finding 7 (LOW, pinned): `interruptUnsafe` leaves the execution unqueryable — `poll` becomes a defect

`layerMemory.ts:218-226` kills the round fiber directly; `poll` then dies on
the bare interrupt exit (`layerMemory.ts:287-293`). The suite pins this and
calls it out itself (`test/FlowEngineMemory.test.ts:412` — "even
`interruptUnsafe` — which promises no cleanup — currently tears...", assertion
at 462-466). Skyframe guarantees a queryable graph after any abort — the
in-flight set is drained so no node is left in a partially computed state
(`AbstractParallelEvaluator.java:82-84`). "No cleanup or compensation"
(`Encoded.ts:97-99`) should still mean `poll` answers a recorded cancellation
rather than throwing. Low because pinned and the safe `interrupt` path
converts correctly (`layerMemory.ts:196-215`).

---

## Finding 8 (LOW): no invalidation, deletion, or eviction of any engine state

`layerMemory`'s `executions`, `actions`, and `deferredResults` maps
(`layerMemory.ts:65,70,130`) grow monotonically; there is no analog of
Skyframe's dirtying/deletion machinery (`EagerInvalidator.java`,
`InvalidatingNodeVisitor.java`) at any layer of this package's seam — the
`Encoded` contract has no invalidate/evict operation at all, so even a
durable driver cannot be told to drop a poisoned row through this port
(compounding Finding 6). The layer's docs say "not suitable for production"
(`layerMemory.ts:28-30`), but `FlowProxyServer.layerHttpApi`/
`layerRpcHandlers` wire transports straight to whatever engine is provided,
making a long-lived in-memory deployment the path of least resistance.

---

## Areas reviewed and found sound (one line each)

- **Key identity** (`ActionKey.ts:115-197`): name-namespacing, declared-schema
  digest folding, boundary-descriptor folding, form disambiguation, and
  nondeterministic-flag folding are a faithful, well-argued `SkyKey`
  discipline; the caller-object escape hatch's schema-staleness risk is
  handled legibly at decode (`make.ts:512-528`).
- **Ordinal allocation scopes and the `ConcurrentKeylessDispatch` refusal**
  (`make.ts:531-584`, `FlowInstance.ts:33-56`): a sound, arguably
  stricter-than-Temporal answer to replay-stable identity for keyless
  dispatches; the acquire/release uninterruptible region (issue #139) is
  correct.
- **Retry durability** (`make.ts:355-405`, `Encoded.ts:123-157`): durable
  retry origin, attempt-counter resume, and the single retry-decision point
  match Temporal's persisted-expiration model; defects correctly do not
  consume attempts (`EngineEdgeGaps.test.ts:187-224`).
- **Error propagation**: typed, sequential, and correct for this model — a
  failed step fails the run and dependents never dispatch
  (`IncrementalInvalidation.test.ts:118-189`); Skyframe's transitive
  `ErrorInfo.fromChildErrors` / `bubbleErrorUp` (`ErrorInfo.java:63`,
  `ParallelEvaluator.java:285`) exist for keep-going parallel graphs and have
  no counterpart to demand here.
- **Round identity** (`Round.ts:60-105`): deriving round N+1's execution id
  from `(lineageId, ordinal)` makes the handoff at-most-once across process
  death; the budget-counts-rounds decision is coherent and tested.
- **Change pruning / versions, as a design decision**: collapsing
  dirty→recheck→rebuild to key-based invalidation is legitimate for
  caller-declared digests, with the honest consequence that there is no
  early cutoff — Skyframe skips a parent when every child re-evaluated to the
  same version (`AbstractParallelEvaluator.java:86-91`,
  `NodeVersion.java:25-41`, `DirtyBuildingState.java:173-198`); here a
  changed input digest re-runs every downstream run-local step even when the
  rebuilt artifact is byte-identical, unless the caller manually folds the
  artifact value into the dependent's own key. Worth a spec note, not a bug.

## Summary table

| # | Severity | Area | One-line statement |
|---|----------|------|--------------------|
| 1 | HIGH | wake signals | `resume` drops a wakeup that lands while the round fiber is live; re-signal is a no-op; discard runs park forever |
| 2 | HIGH | cycles | No cycle detection; parent-chain cycle deadlocks; contract and README promise `FlowCycleDetected` |
| 3 | HIGH | memoization × interruption | Interrupt-only failure exits are memoized and replayed as outcomes, against the driver contract |
| 4 | MEDIUM | trampoline | discard+handoff stalls the lineage; post-handoff rounds drop the parent wake edge |
| 5 | MEDIUM | in-flight dedup | Same sealed key double-executes concurrently; `nondeterministic` first-wins rule unimplemented |
| 6 | MEDIUM | error caching | No transience: a transient failure poisons a cross-run key permanently |
| 7 | LOW | interruption | `interruptUnsafe` leaves `poll` a defect (pinned) |
| 8 | LOW | invalidation | No evict/delete anywhere in the seam; in-memory state grows unboundedly behind real transports |


## packages/engine-store

# engine-store vs. Skyframe: review findings

Reviewed: `packages/engine-store/src` (PlanScheduler, internal/ActionPersistence,
internal/RunDriver, internal/AttemptAdmission, StepBoundary, Inconsistency,
EngineStore composition) against
`reference/bazel/src/main/java/com/google/devtools/build/skyframe`. Also read
`packages/plan/src/Plan.ts` where the scheduler's invariants are anchored there,
and the tests that pin intent (CycleDetection, NonRetryableReplay). Not deeply
reviewed: DurableEngineState timer/deferred internals, WorkspaceSandbox
copy-back internals, ArtifactGc. Those are Temporal-domain, not Skyframe-domain,
and claims below are limited to what was read.

All line numbers are from the current working tree.

## Findings, ranked

### 1. HIGH — Scheduler dispatches bypass the shared attempt-admission mutex, so same-key concurrency is unserialized

`PlanScheduler.dispatch` constructs a fresh `ActionPersistence.make` inside the
per-attempt loop and passes no `admission`
(`packages/engine-store/src/PlanScheduler.ts:916-931`). `ActionPersistence.make`
then falls back to a private mutex per `make` call
(`packages/engine-store/src/internal/ActionPersistence.ts:440`), and its own
option doc states that fallback is "correct only when all same-key dispatches
share the returned executor"
(`internal/ActionPersistence.ts:317-324`). The scheduler violates that
precondition on every dispatch: each attempt gets its own mutex, so
`admission.withPermit(runId|keyDigest)` (`internal/ActionPersistence.ts:745`)
excludes nothing. The production flow-action path gets this right by sharing one
instance per incarnation (`packages/engine-store/src/EngineStore.ts:99-103` and
`:185-193`); the scheduler path silently reopens the hazard issues #102/#103/#118
closed.

Same-key concurrency inside one run is not hypothetical. The scheduler's own
FactorOut story depends on it: "two identical extracted steps collapse to one
key by themselves, so the second is a `clean`"
(`PlanScheduler.ts:863-865`), and `digestToNode` explicitly models several nodes
dispatching under one digest (`PlanScheduler.ts:1012-1018`). Two identical
read-only nodes (no write overlap, so the compiler's serialize pass at
`packages/plan/src/Plan.ts:361-447` adds no ordering edge between them) are
admitted in the same wavefront and compute the same dispatch key concurrently.

Failure scenarios, both observed from the code paths:

- Loser's `attempts.put` sees the winner's row already inserted and returns a
  non-`Inserted` outcome, which surfaces as `AttemptAdmissionRejected`
  (`internal/ActionPersistence.ts:1220-1235`). The scheduler classifies that as
  an ordinary node failure (`PlanScheduler.ts:947`), so a valid plan settles a
  node `failed` because two of its nodes happened to share a key.
- Worse interleaving: B's `attempts.get` observes A's live `running` row. The
  adoption logic concludes it "cannot belong to a live in-process fiber — a
  live same-key dispatch of this process would be holding the permit"
  (`internal/ActionPersistence.ts:1183-1207`). With per-dispatch mutexes that
  premise is false: B adopts the live row, both bodies execute, and the second
  `attempts.finish` returns non-`Finished`, which self-interrupts
  (`internal/ActionPersistence.ts:1620`). The scheduler converts a dispatch
  interrupt into interruption of the whole run (`PlanScheduler.ts:946`), so a
  duplicate sealed step kills the run in a way that is indistinguishable from
  fence loss.

Skyframe's counterpart invariant: one node entry per key, and at most one
evaluation of a key in flight per evaluator. The graph's `createIfAbsentBatch`
plus the node-entry lifecycle guarantee two parents requesting the same key
share one evaluation (`AbstractParallelEvaluator.java:172-402`,
`enqueueChild`); duplicate concurrent evaluation of one key is structurally
impossible. Our analog of the node entry is the attempt row, and the permit is
what makes it single-writer in-process. The scheduler dropped the permit.

Fix shape: hoist `ActionPersistence.make` out of the attempt loop and thread
one `AttemptAdmission.Service` per scheduler (`make(options)` scope), or accept
it via `Options` so `EngineStore`'s incarnation-wide instance can be shared.

### 2. HIGH — The run loop exits silently on a stalled graph and reports never-evaluated nodes as `skipped`

The coordinator loop breaks when nothing is in flight but nodes are still
pending (`PlanScheduler.ts:1351-1353`). No error is raised, no journal record is
written, and the final report reads each such node's default state, whose
outcome is `"skipped"` (`PlanScheduler.ts:544-551`, report assembly at
`:1419-1429`). `skipped` is a normal outcome consumers act on (it closes
selection debt logic differently, feeds plan cards, and reads as "cone failed"),
and these nodes also never get the `nodeSettled` journal record every other
settled node gets (`PlanScheduler.ts:817-831`), so the journal and the report
disagree.

The `v8 ignore` comment argues the branch is unreachable: compiled plans are
acyclic (`packages/plan/src/Plan.ts:289-296` refuses cycles and unknown
dependencies) and discovered edges point only at settled nodes
(`PlanScheduler.ts:858-861`). The reachability argument is sound today. The
problem is the failure mode when any upstream invariant breaks (a `Plan.append`
regression, a reconciler returning an edge shape the guard misses, a future
non-sink deferral): the run completes with a success-shaped report that
misattributes never-evaluated work as skipped.

Skyframe treats exactly this state as a first-class outcome, never as silence.
`ParallelEvaluator.constructResult` collects every top-level key that is not
DONE when work runs out as a cycle root and runs the cycle detector
(`ParallelEvaluator.java:501-563`, `checkForCycles` at `:561`,
`SimpleCycleDetector.java:42-92`), then `checkState`s that a result exists at
all (`ParallelEvaluator.java:564-570`). Anything that "should never happen"
routes to `GraphInconsistencyReceiver`, whose default throws
(`GraphInconsistencyReceiver.java:29-39`). engine-store already has the
receiver (`src/Inconsistency.ts`, explicitly modeled on Skyframe's) but does
not route this case to it.

Fix shape: replace the bare `break` with a typed failure
(`SchedulerError`, or an `Inconsistency` note under the strict default) that
names the pending nodes and their unsatisfied dependencies. Cheap, and it turns
a silent wrong report into a loud defect.

### 3. MEDIUM — Shared cache is consulted before the run's own durable attempt row, so replay can contradict recorded history

The dispatch path checks the shared cache first
(`internal/ActionPersistence.ts:782-997`) and only then reads this run's own
attempt row (`:999`). The failed-row branch exists precisely to make replay
faithful: a durably failed attempt is replayed by rethrowing the persisted
cause so non-retryable classification applies on resume exactly as it did live,
with Temporal's persisted-failure model cited in-file
(`internal/ActionPersistence.ts:1142-1169`), and
`test/NonRetryableReplay.test.ts:114+` pins that guarantee. But that test's
action carries no hard boundary, so `cacheable` is false and the cache block
never runs. For a cacheable step the ordering inverts the guarantee: if a
sibling run recorded a verified success under the same key between this run's
durable failure and its resume, the resumed dispatch returns the cached success
at `:842` without ever seeing its own failed row. The same ordering also lets a
verified hit shadow this run's own succeeded row when the two disagree
(a nondeterministic step), silently preferring the foreign result.

A failed local row plus a successful shared row under one content-addressed key
is "same key, different answer" — the exact definition of the divergence
`CacheConflictDetected` and the `Inconsistency` receiver exist for
(`internal/ActionPersistence.ts:148-155`, `src/Inconsistency.ts:1-20`) — yet
this instance of it is resolved silently by check order.

Skyframe's invariant: a node's own done entry is authoritative; the evaluator
answers from `entry.getValue()` when the entry is done
(`AbstractInMemoryMemoizingEvaluator.java:268-278`), and reuse across versions
goes through that same entry's version comparison
(`IncrementalInMemoryNodeEntry.java:178-188`). Nothing outside the node's own
entry can override its recorded outcome for the current evaluation.

Fix shape: consult `attempts.get(attemptId)` first; replay a terminal row when
one exists (both branches already exist below), and consult the shared cache
only for attempts with no terminal row. If a terminal row and a cache row
coexist and disagree, note it through `Inconsistency` instead of picking one
silently. Within-run retries (a new attempt number, no terminal row) still hit
the cache, so the `clean` fast path is unaffected.

### 4. MEDIUM — A `Reorder` verdict is silently discarded for owners that are running or settled, so arrival order decides its effect

`applyVerdict` applies a discovered ordering edge only when the owner is still
`pending`; a running or settled owner is skipped with no record
(`PlanScheduler.ts:852-864`). The deviation drain's own header states its two
properties exist so that "arrival order" never "decide[s] a verdict"
(`PlanScheduler.ts:1057-1068`), but verdict application is arrival-order
dependent: the common case for a discovered conflict is precisely two siblings
admitted in the same wavefront, and by the time the deviator settles and its
deviation is judged, the owner named in `verdict.dependsOn` is already
`running`. The reconciler's requested ordering ("owner must run after the
deviating node") is then neither enforced, nor failed, nor journaled as
dropped; the `nodeReconciled` record shows the verdict but nothing records
that its edge had no effect. An owner that already settled is the same silent
case with the violation already realized.

Correctness of the cache is not at stake when a sandbox is composed (the owner
executed against its seeded read set, matching its measured key), but the
reconciliation contract is: the seam exists to decide these situations, and
its decision silently degrades to a no-op on timing.

Skyframe never lets a node complete against dependency state it did not
register: a previously requested dep that is no longer done restarts the node
from scratch (`AbstractParallelEvaluator.java:796`), and externally forced
recomputation goes through reset/rewind machinery that dirties the affected
subgraph (`AbstractParallelEvaluator.java:841-874`). When it cannot honor an
invariant it reports through `GraphInconsistencyReceiver`
(`GraphInconsistencyReceiver.java:29-39`) rather than dropping the event.

Fix shape (minimum): journal a distinct record when a `Reorder` edge is
discarded because its owner is not pending, so the drop is a durable, visible
fact. Better: hold the verdict for a running owner and re-ask the reconciler
when it settles (the machinery for deferred judgment already exists in
`pendingDeviations`).

### 5. LOW — Skipped settlements carry no error provenance

A node blocked by a failed, skipped, or deferred dependency settles `skipped`
(`PlanScheduler.ts:1208-1227`), and its `nodeSettled` record and report entry
carry only the outcome (`PlanScheduler.ts:822-830`, `Settlement` at
`:192-201`). Nothing links the skip to the failing root: a consumer of `Report`
must re-derive the dependency graph and intersect it with failed outcomes to
answer "why did this node not run". Skyframe propagates that provenance
structurally: a parent's `ErrorInfo` is built from its children's, unioning
root causes and cycle info as errors bubble
(`ErrorInfo.java:63-91`), so every error-valued top-level node names its roots.
Adding the blocking dependency ids (or the failed roots) to the `skipped`
settlement record would close the gap cheaply. Observability gap, not a
correctness bug.

## Areas checked and found sound

- **Change pruning / dirty checking.** Dispatch-key content addressing plus
  hit-time re-measurement of the declared read set
  (`internal/ActionPersistence.ts:793-803`, issue #90) is a correct analog of
  `DirtyBuildingState.signalDep`'s `VERIFIED_CLEAN` transition
  (`DirtyBuildingState.java:173-198`) and of change-pruned reuse
  (`EvaluationProgressReceiver.java:29-39`, `:144`); stale rows are evicted
  under a provenance-fenced compare-and-swap (issue #119), which closes the
  delete-a-fresh-row race Skyframe never faces.
- **Version handling.** There are no graph versions; the per-run source pinning
  in `observeReads` (`PlanScheduler.ts:698-728`) provides the
  one-consistent-view-per-evaluation property Skyframe gets from `Version`, and
  a crash-resume re-pins and re-keys the whole plan consistently (unchanged
  content replays cheaply through attempt rows, changed content re-executes
  under new keys). Sound.
- **Cycle detection at the run level.** The durable parent-edge table with
  transactional insert-and-check, concurrent cycle formation, cross-process
  races, chord-vs-closing-edge arbitration, and restart persistence are all
  pinned by `test/CycleDetection.test.ts`. Sound; the missing piece is the
  plan-level runtime backstop of finding 2.
- **Reverse-dep index deliberately absent.** The deviation is documented
  (`PlanScheduler.ts:18-23`) and holds: content addressing substitutes for
  `EagerInvalidator`/`InvalidatingNodeVisitor` within a run, and the plan
  compiler's reader-after-writer pass (`packages/plan/src/Plan.ts:399-447`)
  makes "producer settled before reader measures" structural rather than
  assumed.
- **Interruption handling.** Fence loss surfaces as self-interruption
  everywhere durable writes happen; `settleInterrupted` discriminates
  cancellation from shutdown by durable state
  (`internal/RunDriver.ts:740-748`); the irreversible-effect boundary is
  uninterruptible around its intent/outcome records
  (`internal/ActionPersistence.ts:1449-1460`); parked flow scopes have exactly
  one owner and idempotent release. This is materially stronger than
  Skyframe's thread-interrupt story.
- **Memoization, adoption, convergence.** The succeeded/failed-row replay
  branches, crash-window convergence into cache and journal, corruption
  quarantine split between evictable cache rows and non-evictable succeeded
  rows, and the REAPI-ordered publish protocol are thorough and internally
  consistent, modulo findings 1 and 3.


## packages/step-cache

# Review: `@smthrs/step-cache` vs Bazel Skyframe

Date: 2026-08-19. Package: `flows/packages/step-cache` (src @ current working tree).
Prior art: `reference/bazel/src/main/java/com/google/devtools/build/skyframe` and, where
the package itself cites it, `reference/bazel/.../lib/remote`.

## Scope calibration

`step-cache` is not a Skyframe evaluator. It is the durable content-addressed
result store: a head table (`flows_step_cache`), an append-only provenance
ledger (`flows_step_cache_recorded`), a two-tier local/remote composition, and
a dumb-HTTP remote tier. The Skyframe areas that live *outside* this package —
node dirtying and change pruning, dependency bookkeeping, cycle detection,
error bubbling, partial re-evaluation — are implemented by its consumers
(`engine-store/src/internal/ActionPersistence.ts` does the Skyframe-style
dirty check at lines 788–795 and Skyframe-style invalidation at 958–979) and
are out of scope here. This review holds the package to the invariants that
*do* land in a memoizing store: version/provenance discipline, reuse
correctness, invalidation soundness, atomicity under interruption, and the
inconsistency-surfacing posture of `GraphInconsistencyReceiver`.

Findings are ranked. Evidence lines refer to the files as read today.

---

## Finding 1 — HIGH: the fenced `get` falls back to the mutable head silently, so replay of non-recording frames is not a function of durable state

**Our code.** `GetOptions.recordedBy` promises that "an old frame's projection
stays a function of durable state: evicting or replacing the head never
changes what that event recorded" (`src/CacheStore.ts:101–114`). The
implementation delivers that only when the fence names a ledger row. When the
ledger misses, `get` returns the head with no signal that the fence was not
satisfied (`src/CacheStore.ts:320–349`): the caller cannot distinguish "exact
recorded bytes" from "whatever the head holds today".

**Why the fallback is hit in practice.** The one fenced consumer is time-travel
replay, which fences every cache-carrying journal entry with its *own*
coordinates: `cache.get(cacheKey, { recordedBy: { runId: options.runId,
eventSeq: entry.seq } })` (`time-travel/src/internal/Replay.ts:112`). Only the
`recorded` provenance record's seq equals the entry's `recordedEventSeq`
(`ActionPersistence.ts:629–646`). Every *other* cache-carrying record — the
sealed-tier attempt lifecycle records that carry `cacheKey`
(`ActionPersistence.ts:762`) and any frame whose run reused a row recorded by
another run — misses the ledger and replays the head.

**Why the head moves.** The engine's own sanctioned flows replace the head
under an unchanged digest: the stale-read-set path evicts and lets the
re-execution "record cleanly under the same key"
(`ActionPersistence.ts:958–979`), and corruption quarantine does the same
(`ActionPersistence.ts:893–913`). After either, replaying an old hit-frame
serves the *new* result. The projection silently diverges from what the run
observed. Note the durable pointer needed to do this right already exists: the
verified-hit record journals the recorder's `recordedRunId`/`recordedEventSeq`
(`ActionPersistence.ts:826–835`), but `Replay.ts:52` decodes only `cacheKey`
and never uses it.

**Skyframe counterpart.** A Skyframe value observed at a version is stable:
`NodeVersion.java:19–39` — re-evaluation to an equal value keeps
`lastChanged`, and a dep at a version `atMost` the node's evaluated version is
by definition the same value the node saw. Skyframe never silently substitutes
a value from a different version; Temporal (the repo's other durability
reference) fails replay on nondeterminism rather than diverging silently.

**Fix shape.** Either (a) make `get` report which source answered
(`ledger | head`) so replay can fail closed or journal the divergence, or
(b) fail/flag the fenced read when the ledger misses *and* the head's
`(recordedRunId, recordedEventSeq)` differs from the fence, and fix
`Replay.ts` to fence with the journalled recorder provenance where the record
carries one. Today's shape is (silent fallback) the worst of both.

---

## Finding 2 — HIGH: `CombinedCacheStore.get` drops the provenance fence on the conflict re-read

**Our code.** On a local miss + remote hit, the write-back may lose to a
sibling's concurrent `put` (`Conflict`), and the code re-reads the durable
local row to serve it — but drops the caller's `options`:

```ts
const durable = yield* local.get(keyDigest)          // src/CombinedCacheStore.ts:90
```

The write-back's ledger insert is unconditional and commits even when the head
insert conflicts (`src/CacheStore.ts:360–372`: ledger lands "first and
unconditionally", `ON CONFLICT ... DO NOTHING`, and a `Conflict` outcome is a
committed value, not a failure). So at line 90 the local *ledger* already holds
the exact recorded row the fence names; passing `options` through would serve
it. Instead a fenced caller — a replay — is handed the sibling's *different*
result. This is precisely the "cache collision the caller cannot detect" the
adjacent comment (lines 87–89) says the branch exists to prevent, inflicted on
the one caller class that stated its provenance.

**Skyframe counterpart.** Same invariant as Finding 1 (`NodeVersion.java:26–39`);
the fence is this store's version token and must bind through every tier.

**Fix.** `local.get(keyDigest, options)`. One-word change; the unfenced path is
unaffected because without `recordedBy` the two calls are identical.

---

## Finding 3 — MEDIUM-HIGH: `RemoteCacheStore.get` ignores `GetOptions`; the HTTP protocol has no recorded-version read

**Our code.** The remote `get` signature drops the options parameter entirely
(`src/RemoteCacheStore.ts:92`: `(keyDigest: string) => ...`), and `GET
/ac/{key}` carries no provenance (`src/RemoteCacheStore.ts:88`). Yet
`CombinedCacheStore.get` forwards the fence and documents that "each tier
answers with its recorded version when it holds one and its head otherwise"
(`src/CombinedCacheStore.ts:72–76`). That claim is false for the remote tier: a
fenced replay that misses locally is served the remote *head* — any version,
any provenance — and (per Finding 2's mechanics) it is then written back
locally as if it were the recorded evidence.

The asymmetry is already solved elsewhere in the same file: `evict` rides its
fence as `recordedRunId`/`recordedEventSeq` URL params so the server can CAS
(`src/RemoteCacheStore.ts:163–174`). `get` should send the same params and the
protocol should define the recorded-version read (or the remote tier should be
excluded from fenced lookups so the fence degrades *visibly*, per Finding 1's
fix).

**Counterpart.** Bazel's remote action cache never claims version pinning — but
it also never promises it. Our `GetOptions` doc does (`src/CacheStore.ts:103–109`).
The bug is the unkept promise, and TypeScript's parameter-arity subtyping made
it silent.

---

## Finding 4 — MEDIUM: the remote `Conflict` signal is undecidable — non-canonical body plus per-writer provenance fields

**Our code.** `RemoteCacheStore.put` delegates the `ExistingSame`/`Conflict`
decision to the server ("`409` … it held a *different* one",
`src/RemoteCacheStore.ts:70–75, 149–151`) but gives the server no basis to
decide it correctly:

1. The body is `bodyJsonUnsafe(encoded)` (`src/RemoteCacheStore.ts:147`) —
   `JSON.stringify` key order. The module canonical-*checks* `result` and
   `meta` (lines 143–144) and then discards the canonical text. A server that
   compares bytes sees two structurally equal results built in different key
   orders as different — the exact spurious-`Conflict` bug the local store
   fixed by canonicalizing on the way in (`src/CacheStore.ts:200–216`).
2. The body embeds `createdAtMs`, `recordedRunId`, `recordedEventSeq`, which
   differ for every writer. Two machines recording the *identical result*
   therefore always produce different bytes, so any byte-comparing server
   answers `409` for the routine benign race.

`docs/specs/Concepts/Remote Cache.md` never states the server's comparison
rule (no mention of 409/Conflict at all), so nothing pins the correct
implementation ("compare canonical `result` only", which is the local rule at
`src/CacheStore.ts:383–392`).

**Blast radius.** Through `CacheSync` the outcome is discarded, so today the
misclassification is masked (`engine-store/src/CacheSync.ts:106–113`). But
`RemoteCacheStore.layer` composes the remote tier directly as the `CacheStore`
tag (`src/RemoteCacheStore.ts:195–198`), where a spurious `Conflict` feeds the
strict `Inconsistency` verdict and fails the run
(`ActionPersistence.ts:708–729`) — a `CacheConflictDetected` naming a
divergence that does not exist, which is verbatim the failure mode the
canonicalization comment says was already fixed once.

**Skyframe counterpart.** Change pruning compares *values* structurally, never
serialization accidents or metadata:
`DirtyBuildingState.unchangedFromLastBuild` (`DirtyBuildingState.java:214–219`,
`getLastBuildValue().equals(newValue)`) and
`IncrementalInMemoryNodeEntry.java:169–186`.

**Fix.** Publish the canonical serialization (`encodeCanonical` output is
computed and thrown away today) and specify in `Remote Cache.md` that the
server's conflict comparison is canonical `result` bytes only.

---

## Finding 5 — MEDIUM: a shared-tier outage fails lookups (and therefore dispatches) instead of degrading to a miss

**Our code.** `CombinedCacheStore.get` propagates any remote failure
(`src/CombinedCacheStore.ts:76`), and no consumer downgrades it: engine-store
contains zero handlers for `persistence_failed`, and the dispatch path fails
on a failed `cache.get` (`ActionPersistence.ts:783`). With the documented
production shape ("the intended production shape is `CombinedCacheStore`, with
this as its remote tier", `src/RemoteCacheStore.ts:190–192`), a shared-cache
outage turns every local-miss lookup into a run failure.

This contradicts the repo's own posture — "a shared cache is an accelerator …
failing a completed run because an optional tier is unreachable trades a real
result for an unavailable one" (`engine-store/src/CacheSync.ts:23–28`) — which
is currently enforced for publication only.

**Bazel counterpart.** `RemoteSpawnCache.java:206–217`: an `IOException`
during cache lookup is reported as a warning and the spawn falls through to
execution. The module `CombinedCacheStore` cites (`CombinedCache.java`,
`downloadActionResultAsync` at 230–280) sits under that policy.

**Status.** Latent: production wires the local tier only today
(`flows/src/NodeRuntime.ts:97`). But the failure mode ships with the
documented composition, and nothing tests it. Decide the policy in the
combined store (remote lookup failure → miss + journalled/metric'd refusal),
not in every caller.

---

## Finding 6 — MEDIUM-LOW: a `decode_failed` head row is a permanent poison; no quarantine path exists for it

**Our code.** A head row whose JSON no longer decodes fails every `get` with
`decode_failed` (`src/CacheStore.ts:285–300`), and the durable test pins that
this blocks the lookup *before* the remote tier and the write-back that would
heal it (`test/CacheStoreDurable.test.ts:194–258` — deliberately, to avoid
masking). But no caller ever evicts on `decode_failed`: the engine's
quarantine (journal + fenced evict, issue #164) runs only for *measured
artifact* corruption after a successful decode
(`ActionPersistence.ts:893–913`). A row-level poison therefore fails the key
on every future dispatch forever — the exact permanent-poison shape issue #164
was raised to eliminate for inline evidence. Mitigation: the schema's
`json_valid` CHECKs (`src/migrations/0001_initial.ts:30–31`) mean this needs
out-of-band corruption; the test constructs it precisely because interrupted
writers and foreign processes can.

**Counterparts.** Bazel treats a corrupt action cache as discardable state:
`CompactPersistentActionCache.java:478–483` moves the corrupt cache aside and
starts fresh. Skyframe routes unexpected node state through
`GraphInconsistencyReceiver` (`GraphInconsistencyReceiver.java:31–39`) and
rebuilds; it never wedges permanently on it.

**Fix shape.** Route `decode_failed` through the `Inconsistency` receiver like
`noteCorruption`, then fenced-evict the undecodable row (fence on the raw
row's provenance columns, which are readable even when the JSON columns are
not). Keep the read itself fail-closed as tested.

---

## Finding 7 — LOW: `get` does not validate the `recordedBy` fence; `evict` does

`validateFence` exists because "a fence naming an empty run or a sequence
number no journal can record … would misreport the caller's mistake as an
ordinary 'nothing matched'" (`src/CacheStore.ts:246–262`). `evict` applies it
(`src/CacheStore.ts:405`); `get` applies nothing to `options.recordedBy`
(`src/CacheStore.ts:316–338`). A malformed fence — empty `runId`, fractional
or negative `eventSeq` — silently degrades to the head, which by Finding 1 is
the silent loss of replay durability rather than a harmless no-op. Same
validation, same reason, one call.

## Finding 8 — LOW (deliberate, recorded as an invariant asymmetry): cross-machine divergence never reaches the `Inconsistency` receiver

A remote `409` means two machines recorded different results under one sealed
key — the distributed form of exactly the hermeticity violation that is
strict-fail locally (`ActionPersistence.ts:708–729`). Both remote paths drop
it: `CacheSync.publishEntry` maps every outcome to `Option.none()`
(`engine-store/src/CacheSync.ts:106–113`, with a comment electing this), and
inline `CombinedCacheStore.put` discards the remote outcome
(`src/CombinedCacheStore.ts:109`). Skyframe's stance is the opposite default:
`GraphInconsistencyReceiver.THROWING` (`GraphInconsistencyReceiver.java:35`),
and this repo quotes that stance for the local tier
(`ActionPersistence.ts:710–712`) and even for selection
(`JournalRecords.ts:283–284`: "note it, never wire the detector to
/dev/null"). The remote conflict is currently wired to /dev/null. It need not
fail the run — but it should at minimum be journalled/metric'd like an
`unpublished` refusal is.

## Finding 9 — LOW: two-tier metrics count a remote hit as a miss

The local SQL tier records `miss` before the combined store consults the
remote tier (`src/CacheStore.ts:343–345`; `src/CombinedCacheStore.ts:74–76`),
and `RemoteCacheStore` records no lookup metrics at all. In the two-tier shape
every remote hit shows up as one `miss` plus write-back `put` counters, so the
advertised hit-rate metric (`src/CacheStoreMetrics.ts:19–41`) under-reports.
Count the outcome at the composition boundary or tag the tier.

---

## Sound areas

- **`put` atomicity and interruption.** Ledger insert, head insert, and the
  conflict re-read run inside one serialized `DurableWriter` transaction
  (`src/CacheStore.ts:359–393`; contract at
  `database/src/DurableWriter.ts:62–72`), so interruption rolls back both
  tables together and the "row disappeared during put" branch is genuinely
  unreachable. Sound.
- **First-writer-wins and fenced eviction.** The CAS rides inside the `DELETE`
  itself (`src/CacheStore.ts:411–420`), closing the cross-process window a
  read-then-delete leaves; the two-connection SQLite tests pin winner
  integrity, torn-row absence, and stale-fence no-ops
  (`test/CacheStoreDurable.test.ts:88–192`). Sound.
- **`ExistingSame`/`Conflict` by canonical result text, meta excluded.**
  Structural value comparison is the right pruning rule
  (`src/CacheStore.ts:200–221, 383–392`; counterpart
  `DirtyBuildingState.java:214–219`), and excluding `meta` is safe because
  reuse-gating declarations (tier, boundary, nondeterminism) are folded into
  the key digest by the caller, per `ActionPersistence.ts:687–694`. Sound
  locally — the remote tier breaks it, see Finding 4.
- **Publication ordering.** Blobs-before-entry is correctly delegated to the
  caller and documented against `UploadManifest.java:630–633`
  (`src/CombinedCacheStore.ts:10–17`); `deferred` mode exists precisely so no
  host call is held across a write transaction. Sound.
- **Dirtying, change pruning, deps, cycles, error bubbling, partial
  re-evaluation.** Not this package's job; its consumers implement the
  Skyframe-side invariants and this store supplies the fenced primitives they
  need. Assessed only where the store's contract leaks into them (Findings
  1–3).

## Summary

The local single-tier store is solid: atomic, serialized, fenced, and
well-tested at the two-connection boundary. The soft spots are all at the
provenance fence's edges — it is the package's version system, and it
currently binds only on the happy path of the local ledger. Findings 1–3 are
the same invariant (a fence must pin bytes or fail visibly) violated in three
places; Finding 4–5 are the remote tier not yet held to the standards the
local tier set; 6–9 are hardening.


## packages/plan

# `@smthrs/plan` vs Bazel Skyframe: review findings

Reviewed: `flows/packages/plan/src/**` and its tests, against
`reference/bazel/src/main/java/com/google/devtools/build/skyframe` (and
`lib/util/Fingerprint.java`, `lib/actions/ActionKeyContext.java` where the
invariant lives outside the skyframe directory).

Context for calibration: this package deliberately replaces Skyframe's
dirty-node machinery with content addressing. Invalidation is re-keying
(`Plan.ts:7-15`), change pruning is the two-level plan-key/dispatch-key split
(`StepKey.ts:433-448`), and there is no evaluator here; scheduling, error
bubbling, and partial re-evaluation live in `@smthrs/engine-store`. The
findings below are places where that substitution leaks, or where this
package's own invariants are stated but not held.

Findings are ranked by severity.

---

## 1. HIGH — Hermetic write-set canonical order uses `localeCompare`; key determinism depends on the host locale

`StepKey.ts:279-280`:

```ts
const writeSet = [...new Map(normalizedWrites.map((entry) => [JSON.stringify(entry), entry])).values()]
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
```

`String.prototype.localeCompare` with no locale argument collates under the
host's default ICU locale. The sorted `writeSet` is an array, and RFC 8785
canonical JSON preserves array order, so the sort order enters the digest.
Two machines with different locales (or different ICU builds) can hash the
same hermetic declaration to two different keys. This is not limited to
non-ASCII: en-style collation orders `"a" < "Z"` while code-point order gives
`"Z" < "a"`, so any mixed-case multi-entry write set is at risk. Consequences:
cross-machine cache misses for identical steps, and, worse, an approval digest
(`digestOf` covers `effects`, and dispatch keys fold `hermetic`) that does not
reproduce on another machine.

Everything else in this file sorts deterministically: `sortStrings`
(`StepKey.ts:232-233`) uses default code-unit sort, and the `readSet`
comparator (`StepKey.ts:263-265`) uses explicit `<`. Only `writeSet` uses
locale collation. The existing tests cannot catch this: the two pinned exact
digests (`StepKey.test.ts:230`, `:341`) use single-entry write sets, and the
multi-entry normalization test only asserts left === right under one locale.

Skyframe counterpart: `lib/util/Fingerprint.java:275` (map fingerprinting
requires "a deterministic iteration order"); action keys are built from
deterministic byte sequences via `ActionKeyContext`. Nothing in Bazel's
fingerprint path consults locale.

Fix: sort by code units (`left < right ? -1 : ...` on the JSON strings),
matching the `readSet` comparator.

## 2. HIGH — `append` leaves a frozen-reader / new-writer pair unordered and unannotated

The reader-after-writer pass exists because a reader admitted in the same
wavefront as its producer "measures pre-producer bytes and — because the
dispatch key honestly folds the digest it measured — caches that wrong
execution as a legitimate one"; the pass "is what makes the assumption
[`PlanScheduler.measure`'s "their producer has settled"] true"
(`Plan.ts:399-406`). But the pass skips frozen readers entirely
(`Plan.ts:430-431`), and the conflict pass cannot see reader/writer pairs at
all (`Plan.ts:267-271`). So when an elaboration appends a writer for a path a
not-yet-dispatched generation-0 node reads, the pair ends up with:

- no ordering edge in either direction, and
- no conflict annotation on either side (reader/writer pairs are "not a
  conflict", and the frozen row could not carry one anyway).

The behavior is pinned by `test/Plan.test.ts:358-366` ("lands a
reader-after-writer edge on the new node only"): the late writer's
`dependsOn` is asserted `[]`. The test documents the append-only constraint
but not the consequence: the run's outcome now depends on scheduler timing.
If the frozen reader dispatches first it reads pre-writer bytes; if the
writer wins it reads post-writer bytes. Both cache entries are honest, but
the run is no longer deterministic under replay, and the invariant the pass
was written to restore is unenforced again after every elaboration.

Note the asymmetry: for a frozen writer / new reader, the edge lands on the
new reader and all is well (`test/Plan.test.ts:367-372`). For the frozen
reader, an edge is representable without rewriting the frozen row: order the
new writer BEHIND the frozen reader (`late-writer.dependsOn =
["recorded-reader"]`). That is also the semantically right order: the frozen
reader was approved against a plan in which the writer did not exist, so it
should observe pre-writer state. The pass already computes reachability in
both directions (`Plan.ts:437-444`); it just never considers the frozen-reader
case.

Skyframe counterpart: this is exactly the hole its version machinery closes.
When an input changes, `InvalidatingNodeVisitor.java:51-59` dirties the
reverse transitive closure, and `DirtyBuildingState.java:189-190` compares
`childVersion` against `lastEvaluated` so a reader can never consume a dep
state the graph version does not account for. flows rejected reverse deps
because re-keying subsumes them (`Plan.ts:11-15`) — but a frozen node can
never re-key, so for frozen nodes NEITHER mechanism applies. Ordering is the
only remaining tool, and this pass declines to use it.

If `PlanScheduler` independently guards this (e.g. refuses to dispatch a new
writer while an unsettled earlier-generation reader overlaps it), document
that here; nothing in this package or its tests says so.

## 3. MEDIUM — Conflict pass uses a stale transitive closure; serialize edges are not folded through, producing spurious conflicts and spurious `fail` refusals

`annotate` computes the dependency closure once, up front, from material
edges (`Plan.ts:367`, `reachable` at `Plan.ts:327-339`, which copies sets, so
no aliasing). When a `serialize` verdict adds an ordering edge it patches only
the direct entry: `closure.get(later.id)!.add(earlier.id)` (`Plan.ts:395`).
Nodes whose closure was derived from `later` before the patch never see it.

Concrete failure, all in one compile, plan order A, B, C:

- A writes `x`; B writes `x` (no deps); C writes `x`, material dep on B.
- Pair (A,B): overlap, serialize edge B→A, `closure(B)` gains A.
- `closure(C)` was computed from `closure(B)` before the patch, so it is
  `{B}` — missing A.
- Pair (A,C): `closure.get("C").has("A")` is false, so the pair is treated as
  unordered even though the final graph orders C→B→A. Result: a spurious
  conflict annotation on both A and C, a redundant direct edge C→A, and — if
  C declares `conflictStrategy: "fail"` — a `overlap_forbidden` refusal of a
  plan that is in fact fully ordered.

This violates the module's own rule, stated at `Plan.ts:350-351`: "Nodes
already ordered by a dependency path are not conflicts." The spurious
annotations also enter the plan digest (`digestOf` covers `conflicts` and
`dependsOn`, `Plan.ts:475-483`), so plans that should hash identically do not.

The second pass in the same function already got this right: it computes
reachability live over the growing edge set (`reaches`, `Plan.ts:415-427`).
The fix is to make pass one consistent with pass two: either maintain the
closure incrementally in plan order inside the pair loop (serialize edges only
point backward, so plan-order accumulation is sound), or reuse `reaches`.

Skyframe has no direct counterpart (conflicts are a Bazel actions concern,
`ArtifactConflictFinder`), but the invariant "consult the graph as it exists
now, not a snapshot" is the same one `GraphTraversingHelper`-style checks
follow everywhere in the evaluator.

## 4. MEDIUM — `topological` recurses; a deep plan overflows the native stack and escapes as a defect instead of a `PlanError`

`Plan.ts:293-313`: `visit` calls itself per material dependency, so recursion
depth equals the longest dependency chain. A chain-shaped plan of a few
thousand nodes throws `RangeError: Maximum call stack size exceeded`, which
surfaces through `Effect.gen` as a defect (die), not as the typed
`PlanError` the signature promises. Cycle detection is exactly the code that
must survive adversarial graph shapes.

Skyframe pins this invariant explicitly: `SimpleCycleDetector.java:102-104`
— "Maintain a stack explicitly instead of recursion to avoid stack
overflows". This package already follows that rule twice, for exactly this
stated reason: the payload cloner (`internal/node.ts:373-379`, "the walk
carries its own explicit stack rather than recursing, because a payload's
nesting depth ... must not be bounded by the native call stack") and
`reaches` (`Plan.ts:416-427`). `topological` is the odd one out.

Related, lower severity: the cycle error names one node ("Plan cycle through
node X", `Plan.ts:296`) with no cycle path. Skyframe reports the full cycle
and the path to it (`CycleInfo.java:33-47`, `getCycle` /
`createCycleInfo(pathToCycle, cycle)`), which is what makes a cycle in a
compiled, id-rewritten graph debuggable. An explicit-stack rewrite gets the
path for free.

## 5. MEDIUM — `DigestMemo` is poisoned by interruption and caches failures forever

`StepKey.ts:171-186`: the first caller for a `[from, path]` address installs a
`Deferred` and completes it with whatever exit `compute` produces
(`Effect.onExit((exit) => Deferred.done(pending, exit))`). Two problems:

- **Interruption poisons the entry permanently.** If the first computing
  fiber is interrupted (a sibling dispatch failed and the scheduler tore down
  the wavefront's scope — the normal Effect cancellation path this repo
  mandates), the deferred is completed with the interrupt exit. A completed
  deferred never un-completes, and entries are never removed, so every later
  `digest()` call for that address awaits the poisoned deferred and is itself
  interrupted (`reference/effect/packages/effect/src/Deferred.ts:604`:
  "Fibers waiting on the Deferred are interrupted"). A retried node that
  shares the memo can never compute its dispatch key again.
- **Failures are memoized with no transience distinction.** A failed
  `compute` exit is cached and replayed to every subsequent caller. For a
  deterministic `SchemaError` this is arguably correct, but the memo has no
  way to distinguish a transient failure, and no eviction.

Skyframe holds both invariants explicitly: an interrupted evaluation leaves
in-flight nodes cleaned so the next evaluation restarts them
(`DirtyAndInflightTrackingProgressReceiver.java:102-112` — enqueued nodes
"will be either verified clean, re-evaluated, or cleaned up ... or
interrupt"), and transient errors depend on `ErrorTransienceValue`, which "is
not equal to anything, including itself, in order to force re-evaluation"
(`ErrorTransienceValue.java:18-21`). The memo needs the standard fix Effect's
own caches use: on a non-success exit (at minimum on interruption), delete the
entry instead of completing the deferred, so the next caller recomputes.

## 6. LOW — `PlanDiff.changedFields` omits `placement` and `nondeterministic`, misattributing those re-keys as pure upstream effects

The dispatch body folds `nondeterministic`, `effects`, and `placement`
(`StepKey.ts:388-394`), and the tests pin that each moves the key
(`StepKey.test.ts` "folds effects, placement, and the material version...",
"folds declared nondeterminism..."). But the attribution comparator checks
only body, layers, capabilities, effects, version, and inputs
(`PlanDiff.ts:71-88`). A node re-keyed by a `placement` or `nondeterministic`
edit reports `changed: []` — which the module documents as meaning "re-keyed
purely by an upstream edit whose reference is a Pending with no projection"
(`PlanDiff.ts:31-35`). The report is not just incomplete; it points the human
at the wrong cause. Secondary: `capabilities` and `layers` are compared
order-sensitively while the key normalizes them as sets, so a re-keyed node
whose capability list was merely reordered gets a spurious `"capabilities"`
label. Attribution is human-facing only, so no cache impact.

## 7. LOW — Two documented key-soundness invariants are not enforced in code

- **`nondeterministic: true` changes the digest but nothing refuses reuse.**
  `KeyMaterial.ts:66-67` declares the flag; `fromKeyMaterial` and
  `dispatchIdentity` fold it and mint an ordinary cross-run `content` key. If
  the scheduler does not special-case it, a declared-nondeterministic step
  gets cached and never re-executes — the flag becomes a pure hash
  perturbation. Skyframe treats this as a first-class node property:
  `FunctionHermeticity.java:46-50` (`NONHERMETIC`: "expected to routinely
  produce different results even if its dependencies are unchanged") relaxes
  version-based pruning for such nodes. If enforcement lives in
  `engine-store`, this package should say so where the flag is declared;
  today no consumer of the flag exists outside the hash.
- **`runScope` "is set only when `declared` is `false`" (`StepKey.ts:130-133`)
  is not validated.** `content` accepts `declared: false` with no `runScope`
  and happily mints a cross-run-reusable key for a step whose environment
  identity is unknown — the exact stale-hit vector the docstring warns
  against. One `if` in `content` (or a refinement on `EnvironmentIdentity`)
  closes it. Skyframe's style here is `checkState` at every lifecycle
  transition (`DirtyBuildingState.java:142-148`); invariants that matter are
  asserted, not narrated.

## 8. LOW — `overlaps(Glob, Glob)` and `overlaps(TreeArtifact, Glob)` are constant `true`; under a `fail` strategy the over-approximation becomes a spurious compile refusal

`FileSet.ts:254` and `:260`. The conservatism is documented ("`true` may
over-serialize", `FileSet.ts:238`) and is harmless for `serialize`, but
`pairStrategy` promotes any overlap to a hard `overlap_forbidden` error when
either side declared `fail` (`Plan.ts:228-229`, `:380-387`). A flow that
promises disjointness and declares two obviously disjoint globs
(`src/**` vs `docs/**`) cannot compile. A cheap literal-prefix comparison of
the include patterns (both are workspace-relative, `..`-free, `.`-free by the
`Pattern` schema) would prove disjointness for the common cases. Bazel proves
actual output conflicts from concrete artifact paths rather than refusing on
pattern kind alone.

## 9. LOW — `project` reads inherited properties, so a projection onto a built-in name fails at dispatch instead of hashing as absent

`StepKey.ts:423-430` documents "a segment that does not exist yields
`undefined`, which is a stable, distinct value ... a fact about the graph,
not a failure". But the walk uses bare indexing, so
`project({}, ["toString"])` returns the inherited
`Function.prototype.toString`, and `decodeKey({kind: "input-value", value})`
then fails canonicalization with a `SchemaError` at dispatch time. The
`Planned` proxy refuses `toString`/`valueOf`/`toJSON` accesses
(`Planned.ts:93-98`) but records `constructor`, `hasOwnProperty`, and
`__proto__` as ordinary path segments, so such paths are reachable from
authored flows. `Object.hasOwn` before the read makes the implementation
match its documentation. This is the exported "ONE projection semantics for
the value channel" (`StepKey.ts:415-421`), so any consumer that reimplements
it with own-property semantics would diverge from the key — fix here, once.

---

## Minor notes (no action required individually)

- `PlanStore.append` is not idempotent: a byte-identical re-append fails on
  the node primary key instead of returning an `ExistingSame`-style outcome,
  unlike `record` (`PlanStore.ts:69-73`, `:190-215`). A crash between commit
  and the caller observing it forces manual reconciliation.
- `flows_plan_nodes.ordinal` has no uniqueness constraint
  (`migrations/0001_initial.ts:44-53`); a stale in-memory plan appended by a
  second writer that dodges the generation trigger could produce duplicate
  ordinals and nondeterministic `get` order. `UNIQUE (plan_id, ordinal)` is
  free insurance.
- `internal/node.ts:220-221` reads `globalThis.crypto.getRandomValues` at
  module load, outside any Layer. It is browser-safe, but the repo's own rule
  is "host access goes through a Layer, always — ... random, crypto"; if this
  is a deliberate exception it should carry a ticket per Tickets Not
  Exceptions.
- `branchOrdinal`/`catchOrdinal` (`Node.ts:144`, `:159`) make subject tokens
  process-history-dependent. I verified they never reach key material (flow's
  `Graph.build` substitutes them before material derivation, `Graph.ts:989`,
  `:1021`, and branch/catch bodies carry only tag+predicate/filter,
  `Graph.ts:1006`, `:1041`), so keys are unaffected; but serialized ASTs of
  identical flows differ across processes, which will make AST-level diffing
  or snapshotting noisy.
- The reader-after-writer pass is O(N² · E) (a fresh DFS per pair,
  `Plan.ts:428-447`). Fine at current plan sizes; will need a transitive
  bitset or memoized reachability if plans grow past a few hundred nodes.

## Areas checked and found sound

- **Change pruning / early cutoff**: the plan-key vs dispatch-key split
  (`StepKey.ts:433-448`) is a faithful counterpart of Skyframe's
  `signalDep`/`childChanged` pruning (`DirtyBuildingState.java:189-198`) moved
  into content space, and the value-channel cutoff is well pinned
  (`StepKey.test.ts` "folds the settled output value of a Ref, never the
  upstream's identity").
- **Version handling**: the material version constant folded into every body
  (`KeyMaterial.ts:51`), versioned `FunctionIdentity` algorithm tags
  (`internal/node.ts:204`), and the `key1_` prefix give every digest an
  evolvable namespace; no graph/evaluation version is needed because keys are
  content-addressed. Sound.
- **Key collision hardening**: the nominal `DigestInput` brand, per-variant
  reference tagging, the separate environment namespace, and
  absent-vs-empty distinctions are thorough and each is pinned by a D7 test.
  Sound.
- **Dependency bookkeeping**: edges and hashed references derive from one
  function (`KeyMaterial.dependencies`, `KeyMaterial.ts:93-99`), so they
  cannot disagree; ordering edges are deliberately excluded from keys with
  the cache-hit rationale tested (`Plan.test.ts` "serializes overlapping
  writers ... without re-keying them"). Sound.
- **Error bubbling / transitive error propagation / partial re-evaluation /
  interruption of evaluation**: not in this package by design; the plan is
  inert and the halt rule ("a dependent of failed or skipped work never
  dispatches", `StepKey.ts:452-454`) is a scheduler contract this package
  only documents. Verify in `engine-store`, not here.
- **Append-only persistence**: trigger-enforced immutability plus the
  forward-only generation/base-digest trigger
  (`migrations/0001_initial.ts:64-78`) and the transactional
  append-to-unrecorded-plan refusal (`PlanStore.ts:201-212`) are solid.
- **The hand-rolled SHA-256** (`internal/sha256.ts`): padding, block-count,
  and 64-bit length encoding verified correct by inspection, including the
  56-63-byte tail cases.

