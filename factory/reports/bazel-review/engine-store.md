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
