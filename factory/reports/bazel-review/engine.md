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
