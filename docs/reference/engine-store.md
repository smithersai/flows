# `@smthrs/engine-store-next`

This page is the public API reference for the journal-backed `FlowEngine` composition, deferred/clock state contract, and hermetic boundary contract. The composition bundles anywhere; the shipped storage beneath it is still SQLite-on-Node.

## Bundles for the browser

`@smthrs/engine-store-next` is a **browser entry point**, and the repository's browser gate treats it as one. The two host reads it once made directly — `process.pid` and `randomUUID` from `node:crypto` — moved behind the injectable `OwnerIdentity` service (`packages/engine-store/src/OwnerIdentity.ts`), which closed issue #114: the default reads a process id off `globalThis` where the platform has one and draws an incarnation number from `Random` where it does not, and `layerConstant` pins the whole token. Everything it composes — `@smthrs/crypto-next`, `@smthrs/flow-next`, `@smthrs/journal-next`, `@smthrs/run-store-next`, `@smthrs/step-cache-next`, `@smthrs/database-next`, `@smthrs/kernel-next`, and `@smthrs/engine-next` — is browser-bundleable too. Bundling is still not running: the only `DurableWriter` backing shipped here is `node:sqlite`, so do not describe the durable engine as browser-*ready* until a browser SQL client layer exists. `pnpm run browser` bundles this entry point and fails the build if it regresses. See [browser support](../architecture/browser-support.md).

## `EngineStore`

```ts
const layer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-a",
  isAlive: (owner) => checkOwner(owner)
})
```

`Options` contains `owner.hostId`, `journalSource`, required `isAlive`, and the optional `clockFireRetryPolicy` — the redispatch `Schedule` for a durable clock whose fire failed, defaulting to exponential from 100ms capped at 30s, forever. It is the same option shape as the engine's `suspendedRetryPolicy`: the built-in behavior is the default, and a deployment supplies its own rather than patching the store. `make(options)` returns a `FlowRuntime` service — the port `@smthrs/flow-next` declares; `layer(options)` provides both `FlowRuntime` and `FlowEngine.SnapshotBoundary`. The liveness probe is mandatory because silently treating an unknown owner as alive can strand recovery forever.

Required services are `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, `OwnerIdentity`, and `Scope`. `EngineCompositionError` represents an engine that was invoked without a complete composition.

The engine stores a versioned state envelope in each run row, fences run and attempt ownership, replays encoded exits, and writes engine decisions to the journal. Cache addresses are the injected `Sha256` transformation of the step key, not the raw `key1_…` value.

Durable cancellation is observed, not just recorded: while a run executes, the driver polls `cancel_requested_at_ms` on the heartbeat cadence and cancels the run (interrupting the flow fiber) when another process has called `RunStore.requestCancel`. Terminal transitions are additionally guarded with `{ cancelRequested: "absent" }` inside the ownership CAS, so a request that races past the last poll turns finalize into a cancellation instead of a `completed`/`failed` write.

The driver's periodic sweep (heartbeat cadence) re-drives three durable shapes: parked runs whose cancellation was durably requested, runs parked with reason `released` (interrupt-released by shutdown, issue #39), and stale-running rows left by a hard-killed owner (issue #53) — each re-enters the ordinary claim/steal/activate path. A wake for a flow the sweeping process has not registered is not dropped silently: the driver logs a once-per-run structured warning (run id + flow name) and leaves the durable waiting row parked, so any process that registers the flow still reclaims the run (issue #62).

Every engine-store lifecycle journal write — run decisions, attempt started/finished, hard violations, snapshot identity, cache provenance, deferred completions, clock schedules, interruption records, and the `Inconsistency` cache-conflict record — takes the journal's durable channel (`emitDurable`), so a saturated lossy queue can never drop one. Attempt lifecycle writes additionally pass the owner, fencing the append on the run's persisted ownership: a reclaimed (zombie) owner fails with `fence_lost` and self-interrupts instead of appending.

## `DurableEngineState`

The service addresses deferreds by flow/execution/deferred name and clocks by flow/execution/clock name. It exposes:

- `deferred` and first-writer-wins `completeDeferred`
- `clock`, first-writer-wins `scheduleClock`, and `completeClock`
- `dueClocks(nowMs)`
- owner-fenced `park`, idempotent `wake`, `waiting`, and sweeper-ordered `waitingRuns` — the `WaitingRunsFilter` supports `reason`, `dueBeforeMs`, and a `cancelRequested` predicate over `flows_runs.cancel_requested_at_ms`, so sweepers fetch only actionable rows instead of scanning every parked run (issue #68)
- `staleRunningRuns(staleBeforeMs)` — run ids still `running` whose heartbeat froze before the horizon; the driver's periodic sweep re-drives these through the claim/steal path so a hard-killed owner (SIGKILL, OOM) cannot strand a run (issue #53)
- `recordRunParent(childId, parentId)` — durably records a parent edge in the run DAG (`flows_run_parents`), first-writer-wins per pair. The cycle check is **inside the same write transaction** as the insert: the child→parent chain is walked over the durable edges and on a hit the transaction rolls back and the call fails with the typed `RunParentCycleError` — so a rejected edge leaves no durable trace, and of two concurrent writers whose edges jointly close a cycle exactly one fails (issues #29/#40/#54/#55/#56). The driver maps this error to `FlowCycleDetected` and records the edge before creating the run row, so no `state_json` `parentExecutionId` can outlive a rejected edge. Edge insert and run-row creation run inside **one** storage transaction (`DurableEngineState.transaction`), so a crash between them cannot leave a durable orphan edge for a run that was never created (issue #80). Serialized write transactions are a documented requirement of the `DurableWriter.write` contract, not a SQLite artifact — a Postgres-backed implementation must use `SERIALIZABLE` (issue #74)
- `runParents(childId)` — the recorded edges, oldest first (`seq` is ordering-only)
- `removeRunParentsForRun(runId)` — deletes every edge naming the run as child **or** parent, for lanes that clear edges without deleting the run row. Because `flows_run_parents` deliberately has no FK to `flows_runs`, GC is additionally enforced in the database: an `AFTER DELETE` trigger on `flows_runs` prunes the deleted run's edges in the same transaction, so a lane that never calls this hook still cannot leave ghost edges in a future cycle walk (issues #66/#81)

The run driver populates the waiting taxonomy on the execution path: a run
that suspends parks before its `suspended` transition — reason `timer` with
the earliest pending clock deadline as `wakeAt` when a durable clock is
outstanding, reason `event` otherwise — and every resume wakes (clears) the
waiting payload when the run re-enters `running`. `waitingRuns` and the
waiting-row partial index therefore match real suspensions, not only
rows written through the store API directly.

Outcome unions distinguish newly written, existing, completed, and missing
rows. `make` and `layer` provide SQL persistence through `DurableWriter` and Effect's `SqlClient`;
`makeMemory(options?)` and `layerMemory` are deterministic in-memory
implementations that, given a `runs` lookup, enforce the same
`park`/`wake`/`scheduleClock` ownership fences as the SQL layer — both are
pinned by one shared contract suite
(`packages/engine-store/test/contract/DurableEngineStateContract.ts`).
Clock creation is fenced against the active run owner. Deferred and clock
completion use first-writer and compare-and-set admission before the existing
claim-gated wake path. A durable clock whose fire fails transiently is
redispatched with capped exponential backoff (Temporal timer-queue
semantics) rather than being lost until process restart.

## `StepBoundary`

<a id="stepboundary"></a>

`FileBoundary` from `@smthrs/flow-next`'s `Action` namespace contains `readSet`, `writeSet`, and `boundaryMode` (`hard` or `expected`). A service implements:

```ts
interface Service {
  prepare(descriptor: FileBoundary): Effect<PreparedBoundary, UnsupportedBoundary, Crypto>
  settle(prepared: PreparedBoundary): Effect<BoundaryEvidence, UndeclaredWrite | UnsupportedBoundary>
  replayOutputs(evidence: BoundaryEvidence): Effect<void, UnsupportedBoundary | BoundaryCorruption | MissingArtifact>
}
```

`BoundaryEvidence` contains declared outputs, a diff identity, optional expected-set deviation, and optional `wholeTreeWritesVerified: true`. A hard undeclared write fails with `UndeclaredWrite`; expected mode records a deviation. Cross-run cache admission requires the explicit whole-tree proof.

`MissingArtifact` is the one replay refusal a shared artifact tier can repair — the bytes are simply not on this host — so it is a distinct tag from a corrupt address or a host that refused outright. `referencedDigests(evidence)` names the digests evidence references rather than inlines; that is the set `ArtifactSync` publishes and fetches.

`make(service)` wraps an implementation. `layer` is the filesystem-backed production boundary over the kernel `FileSystem` seam and the `@smthrs/artifacts-next` `ArtifactStore`, which owns the blob mechanics (content addressing, atomic publication, digest verification, dedupe); what stays here is the policy that decides which outputs become blobs at all — the `maxInlineBytes` / `maxTotalInlineBytes` inline-versus-spill budgets. Concretely: `prepare` measures the declared read set's real digests, `settle` detects declared reads mutated outside the declared write set and captures the write set's post-state as materializable outputs, and `replayOutputs` re-materializes them. It cannot detect writes elsewhere in the tree, so it never claims the whole-tree proof itself — that claim now comes from running the body somewhere else, which is [`WorkspaceSandbox`](#workspacesandbox). A composition with a boundary but no sandbox keeps the old, honest outcome: run-local results only. `layerTest(options?)` is deterministic and supports changed-path/deviation/replay/`readSnapshot` assertions, but it does not enforce a real sandbox.

## `WorkspaceSandbox`

<a id="workspacesandbox"></a>

The functional workspace transaction: a sealed action's body runs in an isolated workspace and *returns* its writes rather than performing them.

```ts
interface Service {
  execute<Output, Error>(execution: Execution<Output, Error>): Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto>
  materialize<Output>(accepted: Accepted<Output>): Effect<void, MaterializationConflict | WorkspaceError, Crypto>
}
```

`execute` is speculative and never touches the host. It seeds the transaction with exactly the declared read set — an undeclared file is simply not there, which is `docs/specs/Concepts/Effect Taxonomy.md`'s strong enforcement tier — serves it through both the `Workspace` tag and a re-rooted Effect `FileSystem`, and diffs the whole map at settlement. An execution whose observations contradict its declaration is `Invalidated` in hard mode, and that shape carries provenance and violations *only*: there is no accessor for the candidate output, files, or queued effects.

`materialize` is the single host write and is all-or-nothing: every `FileChange.beforeDigest` is compared against the live host before a byte lands, so a bundle whose base moved is refused whole with `MaterializationConflict` and `ActionPersistence` rebases a bounded number of times. `beforeDigest` describes what is really on the host, including for a declared output the body never declared as a read — the `Host.baseline` seam is what supplies it, because "absent from the seed" is not "absent from the host".

`QueuedEffect`s are deliberately not dispatched inside the transaction: a speculative send has already reached the world when its execution turns out invalid, and reaches it twice when a copy-back loses a race. The optional `EffectDispatcher` stage runs after copy-back settles, deduplicated by idempotency key. The journal records `diff-bundle-captured` and `copy-back-settled`.

`makeMemory` is the deterministic, browser-safe conformance implementation (it seeds the whole tree, so an undeclared read is observable); `makeFileSystem` / `layerFileSystem` back the transaction with the kernel `FileSystem`, the kernel `Workspace` root, and `@smthrs/artifacts-next` for products too large to carry inline. Both are `makeHosted` over one `Host`, so the transaction, the diff, the violation check, and the provenance cannot drift between them.

It is a **deterministic transaction model, not a security boundary**. A body reaching the host through a service the transaction does not seed is outside it; denying that ambient access is the VM/`SandboxProvider` story in `docs/specs/Concepts/Agent Adapters.md`. The human diff-review gate of `docs/specs/Concepts/Diff Review.md` is not implemented — a settled bundle is applied without it (`.smithers/tickets/diff-review-gate.md`) — and the transaction's `FileSystem` surface is deliberately partial (`.smithers/tickets/sandbox-filesystem-surface.md`).

## `PlanScheduler`

<a id="planscheduler"></a>

The node scheduler: it drives a persisted [`@smthrs/plan-next`](plan.md) `Plan` to completion. `record` persists generation 0 and journals `plan-recorded`, `append` persists the newest generation and journals `subgraph-appended`, and `run` walks the graph.

```ts
interface Service {
  record(plan: Plan): Effect<RecordResult, SchedulerError, PlanStore | Journal>
  append(plan: Plan): Effect<void, SchedulerError, PlanStore | Journal>
  run(plan: Plan): Effect<Report, SchedulerError, Requirements>
}
```

Ready nodes dispatch through the same `internal/ActionPersistence` seam every action uses, so the shared step cache, [`WorkspaceSandbox`](#workspacesandbox)'s execute→materialize transaction, attempt rows, and the fenced journal all apply unchanged. The dispatch key folds the plan-time node key together with the boundary the host measured immediately before dispatch: two runs whose input files differ declare the same graph, and serving one the other's result is exactly the staleness the boundary exists to prevent.

Skyframe's `AbstractParallelEvaluator` is the prior art, with two deliberate deviations. There is **no reverse-dependency index and no invalidating node visitor** — `docs/specs/Concepts/Engine Hardening Round 1.md` rejects both, because a node is dirty iff the key it would dispatch under moved and the dispatch-time recheck already computes that. And dependency discovery is a **wavefront** rather than Skyframe's restart-based discovery, because the plan declares its edges before anything runs.

Each node settles as one of four outcomes — `built`, `clean` (the shared cache served it and nothing ran), `failed`, and `skipped` (its cone failed, or `stop-merge` stopped it) — journaled as `node-settled`. Admission is `docs/specs/Concepts/Concurrency.md`'s middle limit only: `concurrency.steps` caps leaf execution and `concurrency.agents` caps the agent subset within it. Both default to unbounded and both floor at one, because a cap of zero admits nothing and a round that admits nothing settles nothing. Ready work is ordered by declared `priority` plus one point per round waited, so priority changes latency without permitting starvation.

Source paths — read by the plan, written by nothing in it — are measured **once** before the first dispatch and pinned for the whole run; produced paths are measured after their producer settles. That is `docs/specs/Concepts/Staleness.md`'s torn-run rule: a rebase re-observes our own outputs, never the world.

The runtime conflict strategies of `docs/specs/Concepts/Runtime Conflict Strategies.md` ride the plan's pair annotations. **delay/rebase** holds the dependents and re-executes against the newly recorded base — the re-measure re-keys, so it is a new attempt rather than a retry of one identity, journaled as `node-invalidated` — bounded by `rebaseLimit`. **stop/merge** stops the loser and appends a merge node to the *same* plan as an ordinary elaboration, with no rebase budget of its own per `Worktree Lanes`' restart-or-fail landing contract. A conflict neither absorbs goes to [`Reconciliation`](#reconciliation).

`NodeExecutor` is the DI seam that turns a `NodeInput` into work: the scheduler owns identity, admission, caching, and journaling, and deliberately owns nothing about what a node *means*.

## `Reconciliation`

<a id="reconciliation"></a>

The pluggable seam for when the world disagrees with the declaration. It is the **first consumer** `flows.engine.expected-set-deviation` has ever had — the emitters shipped with isolated execution and nothing read them.

```ts
interface Service {
  onDeviation(deviation: Deviation): Effect<Verdict>
  onConflict(conflict: Conflict): Effect<Verdict>
}
```

Pluggability is dependency injection at the owning seam, per the repository's extension doctrine; there is no hook kernel. `layerDefault` installs a deterministic verdict function in the vault's order of preference: **`Reorder`** when every undeclared path is one another plan node declares it writes (a real dependency the declaration missed, made explicit), **`FactorOut`** when another node in the same run deviated on exactly the same paths (content addressing collapses two identical extracted steps to one key by itself, so the verdict is a record and a hint), and **`Fail`** otherwise, because a deviation nothing explains is the case the vault calls genuinely wrong. A conflict the runtime strategy could not absorb always fails here: choosing a winner between two landings is a semantic judgement this default does not have the material to make.

The scheduler attributes every deviation on a journal page before judging any of it, so two steps that produced the same undeclared paths both see each other — deviating identically is a symmetric fact, and which of the pair the journal happened to list first must not decide the verdict.

A model-backed reconciler is a different `Layer`. It lives in the agent repository and is tracked in `.smithers/tickets/agent-reconciliation-flow.md`; this package has no model dependency and must not grow one.

## `Selection`

<a id="selection"></a>

The advisory seam: it may schedule work, it may never decide what is cached, correct, or up to date. `docs/specs/Concepts/Probabilistic Selection.md` (`status: draft`) is the design; this package implements v1 of it.

```ts
interface Service {
  select(input: {
    changed: ReadonlyArray<string>
    sinks: ReadonlyArray<{ nodeId: string; planKey: string }>
    present: ReadonlyArray<string>
    beliefs: BeliefSnapshot
    policy: { deferBelow: number }
  }): Effect<ReadonlyArray<{ nodeId: string; verdict: Verdict }>>
}

type Verdict =
  | { _tag: "Admit" }
  | { _tag: "Defer"; edge: SuspectedEdge; likelihood: number }
  | { _tag: "Propose"; flow: string; edge: SuspectedEdge; confidence: number }
```

`BeliefSnapshot` (`pinnedAtMs`, `edges: ReadonlyArray<SuspectedEdge>`) is pinned before planning, and `select` is a pure function of it — no IO, no clock read mid-call. `SuspectedEdge` is `{ scope, affects, confidence, validFromMs, evidence }`, a path glob paired with the flow it is believed to affect. `present` lists every name the plan accounts for — its flow and its node ids — because whether an edge's `affects` names work outside the plan is undecidable from the sink list alone. In the result, `nodeId` names the offered candidate for `Admit` and `Defer`; a `Propose` names work outside the plan, so its entry carries the proposed flow's name instead of a plan node id.

`layerNoop` is the default: every candidate is `Admit`, so engine behavior with no `Selection` layer, or with `layerNoop`, is byte-identical to today. `layerHeuristic` is the only other shipped layer — pure and deterministic, no IO, no model calls: it glob-matches `changed` against the scope of each edge live at the pin (`validFromMs <= pinnedAtMs`), a match yields `likelihood = edge.confidence`, a sink whose best likelihood is strictly below `policy.deferBelow` becomes `Defer` under its best edge, a live edge whose `affects` names nothing in `present` becomes `Propose` — once per flow, under its highest-confidence edge — and everything else is `Admit`. A model-backed layer is a different composition; this package has no model dependency and must not grow one, the same rule `Reconciliation` follows.

`PlanScheduler` consults `Selection` only for sink candidates — nodes with no dependents in the plan. A `Defer` or `Propose` verdict returned for a non-sink is not honored; it is ignored and journaled as an inconsistency observation. A `Defer` settles its node with a new outcome, `"deferred"` — distinct from `clean`/`built` and from the existing dependency-failure `"skipped"` — writes no step-cache row, and is journaled as `flows.engine.selection-deferred` with the node id, dispatch/plan key, the edge, and the likelihood. A `Propose` is journaled as `flows.engine.selection-proposed` (flow, edge, confidence); v1 records and surfaces it and does not append a plan node. A run-level override treats every verdict as `Admit` for one run, journaled the way `--fresh` bypasses the cache.

Four laws hold regardless of which layer is installed: guesses never enter a step key or change a cache row (admitted nodes are byte-identical under `layerNoop` and `layerHeuristic`); `deferred` is never `passed`; only a sink can ever end deferred; and a guess only adds or postpones work, never removes a node the plan requires — the override option restores full execution.

`Selection.debt(runId)` lists that run's open deferred entries as `DebtEntry` values — node, plan key, edge, likelihood, journal provenance. It folds exactly one run's journal rather than projecting into a table: a `flows.engine.selection-deferred` record opens a debt under its plan key, and a later `flows.engine.node-settled` journaled under the same run and key with outcome `built`, `clean`, or `failed` closes it — `skipped` does not, because that work never ran and is still owed. Repayment is therefore same-run: the guess-free pass that closes a debt is the deferring run driven again under the `full` override, so its settlements land under the runId the fold reads. A recertification run holds its own runId and is invisible to this fold; a cross-run repayment query is future work, not shipped in v1. The journal-read matches how the scheduler consumes deviations: a deferral is a durable, replayable fact, and a second store would be a cache of one.

Not in v1: plan-card rendering of `deferred`/`proposed` rows, a model-backed layer, belief training or confidence decay, a read-set proposer for agent steps, plan-level risk scoring, and auto-appending a `Propose` verdict as a plan node.

## `ArtifactSync`

<a id="artifactsync"></a>

The two-tier artifact protocol, and the seam a shared-cache composition injects into. `makeLocal()` is the default when the tag is absent: publish is a no-op and hydrate reports nothing arrived, so a purely local engine pays nothing. `make({ local, remote })` — or `layer(remote)`, which takes the local tier from the `ArtifactStore` tag — implements the real thing:

- `publish(digests)` runs `findMissing` on the shared tier, uploads what is missing, and re-probes to confirm. `ActionPersistence` calls it immediately **before** the transaction that records the cache entry, and never inside it. This is Bazel's REAPI ordering constraint (`UploadManifest.java:630-633`): an action result is uploaded after every blob it refers to, because a result accessed before its blobs are present cannot be validated. A publication that cannot make the artifacts durable fails with `ArtifactPublicationFailed`, and the **shared** entry is withheld.
- `hydrate(digests)` fetches what this host is missing and writes it back locally, reporting whether the replay is now worth retrying. It never fails a run: a shared tier that is down must not stop work that can simply be done.

## `CacheSync`

<a id="cachesync"></a>

The second half of the ordering constraint: the shared step-result tier's `put`, run **after** the transaction that made the local row durable. `makeLocal()` is the default when the tag is absent. `make({ remote })` — or `layer(remote)` — publishes to a remote `CacheStore`, typically `RemoteCacheStore`.

It is a separate seam from the `CacheStore` tag because of *where* the local row is written. `ActionPersistence` commits the cache row and the journal record explaining it in one `DurableWriter` transaction, and nothing that is not storage work may be held across one — a `CacheStore` whose `put` also wrote a shared HTTP tier would put a network round trip inside that transaction, blocking every other writer for its duration and rolling the local row back whenever a *shared cache* was unreachable. So the local put stays inside and the shared put becomes this service. Compose it with `CombinedCacheStore` in `"deferred"` publication mode, which is the mode that leaves the shared write here; lookups stay read-through either way.

Neither publication step can fail a run. Both run after `attempts.finish`, so the result is already durably recorded on this host, and failing a completed run because an optional accelerator is unreachable trades a real result for an unavailable one. A refusal withholds the shared copy — never the local row — and journals a `cache-provenance` record with `action: "unpublished"` carrying the stage (`artifacts` or `entry`) and the reason. That is the same "visible, not silent" treatment an unverified read set gets (issue #106); a missing shared entry is explainable from the journal rather than inferred from its absence.

Downloads are lazy — a replay fetches when materialization actually needs the bytes, so a metadata-only replay state is representable. A Bazel-style download policy (`RemoteOutputChecker`, `--remote_download_{all,toplevel,minimal}`) is out of scope and ticketed in `.smithers/tickets/remote-cache-download-policy.md`.

## Cache admission

EngineStore admits a cache record only when the action is sealed, the boundary is hard, no deviation occurred, and the evidence explicitly carries `wholeTreeWritesVerified: true`. Older evidence and boundaries that observe declared paths only are conservatively refused. Under the production composition that proof comes from [`WorkspaceSandbox`](#workspacesandbox): the body ran in an isolated workspace, so a write outside the declared set is a map comparison rather than an inference, and `ActionPersistence` sets the flag itself — or, when the whole-tree diff shows a deviation the declared-read scan would have missed, records that deviation and withholds the entry. Only a content-key record has an address another run can reproduce; an ordinal-key record remains run-local. A cache hit is verified before it is served (issue #90): the store calls `prepare` and compares the descriptor's declared `readSet` against the `readSnapshot` the host measured. Reuse happens only when every declared read still matches — reads the host reports but the declaration never claimed are ignored, while a declared path that is missing or has a different digest refuses the hit, journals a `cache-provenance` record with `action: "stale_read_set"`, and falls through to a real execution. That is Skyframe's dirty-check invariant; the key alone only detects a *changed declaration*, not a stale one. A verified hit calls `replayOutputs` before returning the stored result. When that refuses with `MissingArtifact` — the normal first answer for a row recorded on a machine whose artifacts this one has never seen — the dispatch hydrates from the shared tier and retries the replay exactly **once** before falling through to a real execution; a second failure means the tier cannot serve it either, and executing is strictly better than looping.

Replaying a succeeded attempt row also converges the cache: if a crash landed between `attempts.finish` and `cache.put`, the restarted executor re-records the sealed completion (with fresh cache-provenance) instead of leaving the cache permanently behind the journal. A divergent first-recorded row still surfaces through the `Inconsistency` receiver, strict by default.

A persisted `failed` attempt row replays by rethrowing the persisted domain failure — never by readmission, so `AttemptAdmissionRejected` marks only genuinely mid-flight (`running`) rows. The `Fail` errors were schema-encoded before persistence, so their `_tag` survives the JSON round trip and `RetryPolicy` non-retryable matching applies on replay (issue #59). The composition also implements the engine's `actionLatestAttempt` (attempt counter resumes from the persisted sequence) and degrades `actionRetryOrigin` to the earliest surviving attempt row when a retention job pruned attempt 1 (issue #69).

See [Assembling a durable engine](../guides/durable-engine.md), [Implementation status](../architecture/implementation-status.md), and [Step keys](../concepts/step-keys.md).

## Migrations and internal scheduling

`@smthrs/engine-store-next` owns `flows_deferred_completions` and
`flows_clock_deadlines` — the persisted `DurableDeferred`/`DurableClock` state
`internal/DeferredPersistence` operates and no other package reads — and
reserves migration id block `3000`. Because it composes every storage package,
`Migrations.sets` is also the complete durable engine schema in dependency
order (journal, run store, step cache, then its own) and `Migrations.layer`
installs all of it. See [`@smthrs/database-next`](database.md) for how the
namespaced sets compose without colliding.

`internal/RunCoordinator` lives here rather than in a storage package because
it is in-memory scheduling, not persistence: `make({ drain })` deduplicates
in-process work by key and exposes `active`, `run`, `wake`, and `interrupt`
around scoped fibers. `RunDriver` is its only consumer. It is not distributed
ownership; that is [`@smthrs/run-store-next`](run-store.md)'s `RunStore`. The shape
is adapted from opencode's `packages/core/src/session/run-coordinator.ts`,
which also lives in the session layer.
