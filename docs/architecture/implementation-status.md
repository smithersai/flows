# Implementation status

This page distinguishes usable source-backed behavior from contracts and planned integration. It is the authoritative documentation-level status table for this unreleased repository.

## Implemented

| Area | Current behavior |
| --- | --- |
| Flow definitions | Typed `Flow.make`, registration layers, explicit or idempotency-derived execution IDs |
| Recorded steps | Typed `Activity.make` with success/error schemas, tiers, metadata, annotations, and encoded exits |
| In-memory runtime | Flow execution, polling, suspension, resume, interruption, deferreds, clocks, and activity memoization |
| Durable run state | SQL-backed run rows, exact claims, activation fences, heartbeats, stale-owner steal, terminal transitions, lineage (`parent_run_id`), and cancellation requests that are durably recorded, polled by the owning driver on the heartbeat cadence, guarded inside both the re-activation and terminal-transition CAS, and delivered to parked runs by a sweeper (issues #26–#28: shutdown interruption releases a run reclaimably instead of cancelling it, cancel of a suspended run is swept and observed, and terminally closed runs never surface as live waiting rows); the sweeper itself is sandboxed — a transient defect (e.g. `SQLITE_BUSY` escaping `waitingRuns()`) is logged and retried on the next tick instead of silently killing delivery for the process lifetime (issue #44); an owner whose heartbeat *writes* fail keeps working only for `heartbeatWriteTolerance`, two ticks shorter than the steal cutoff, so it is always interrupted before a peer may steal the run (issues #47, #61); the same periodic sweep also enumerates stale-running rows (`staleRunningRuns`) and re-drives them through the claim/steal path, so a hard-killed owner (SIGKILL, OOM) no longer strands its run or makes `requestCancel` against it write-only (issue #53); the sweep fetches only actionable rows — reason `released` plus a `cancelRequested` filter predicate — instead of scanning every parked run with a per-row `store.get` (issue #68); and a wake for a flow not registered in the sweeping process logs a once-per-run structured warning and leaves the row parked instead of no-oping silently (issue #62) |
| Attempt state | Fenced attempt admission, a configurable in-progress vocabulary and checkpoint cap, optional upsert admission, first terminal result, an unfenced patch surface, and opaque metadata |
| Journal | Bounded optimistic queue, batching, idempotent producer events, paging, replay-then-follow streams, projections, and a multi-writer-safe `emitDurable` that allocates the canonical sequence inside the write transaction; a lost batch takes only its own entries out of the pending set, so a later `flush` still waits for entries queued behind it (issue #60) |
| Journal redaction | One rule set (`Redaction`) applied at the journal's single encode chokepoint — `payload`/`meta` — with a `redact` option and `SqlJournal.layer` opt-out (issues #46, #58). Scoped to observability: `RunStore` state, `AttemptStore` checkpoint/error/outcome/meta, and `CacheStore` result/meta are executable state and round-trip verbatim, because rewriting them resumes the flow with the wrong data and can make persisted state fail schema decode (issue #72). A secret that must not persist is a `Redacted` field in the caller's state schema |
| Content addressing | Canonical serialization, SHA-256 content keys, graph-reference resolution, and run-local ordinal keys. Activity ordinals are allocated per activity **name** and the name is folded into the key as `parentScope`, so concurrent activities cannot renumber each other across a replay (issue #73); repeated invocations of one activity remain allocation-ordered |
| Cache rows | First-writer-wins content-addressed results with run/sequence provenance |
| Capability kernel | Monotone capability sets, rules, attended/unattended grants, journal-backed decisions, and guarded Host layers |
| Host bundles | Node, Bun, browser/test, Cloudflare, Vercel Edge, and Vercel Node adapters |
| Durable primitives | SQL-backed deferred completions and absolute clock rows, restart re-arming and wake recovery, durable queue API, and attached child flow wake-up |
| Sync | Read-only catch-up and credit-bounded follow over schema-backed Effect RPC |
| Plugin kernel | `@smithers/plugin`: typed hook catalog, `resolve`/`Kernel.make`, `enforce`/`order` resolution, `apply` filtering, config waterfall + `configResolved`, and sequential/parallel/first/waterfall dispatch |
| Cache-conflict receiver | `EngineStore.Inconsistency` (`layerStrict` / `layerTolerant` / `layerNoop`): `CacheStore.put` conflicts are journalled as `flows.engine.cache-conflict` instead of discarded. **The unwired core default is strict** — journal, then fail the run with `CacheConflictDetected` — matching `plugin-system.md`'s `cacheInconsistency` default; provide `Inconsistency.layerTolerant` to opt out |
| Run cycle detection | Cycle rejection is atomic in storage: `DurableEngineState.recordRunParent` inserts the durable parent edge and walks the child→parent chain inside one write transaction, rolling back and failing with `RunParentCycleError` on a hit (no in-process gate, no cross-owner arbitration, no withdrawal protocol — issues #29/#40/#54/#55/#56); the driver records the edge **before** creating the run row, so a rejected request leaves no durable trace, and maps the error to the typed `FlowCycleDetected` (`code: "flow_cycle_detected"`, declared by `Engine.FlowEngine`, in the error channel — not a defect). The edge and the run row are created in one storage transaction, so a crash between them leaves no durable orphan edge (issue #80). Writer serialization is a documented `Database.write` contract requirement (Postgres must run write transactions `SERIALIZABLE`), pinned by a cross-connection race test (issue #74). The edge table is the single cycle-detection input; GC is enforced by an `AFTER DELETE` trigger on `flows_runs` rather than by call convention, with `removeRunParentsForRun` kept for edge-only cleanup (issues #66/#81) |
| Waiting taxonomy | `DurableEngineState.park` / `wake` / `waiting` / `waitingRuns` with `reason`/`wakeAt`/`token` columns (migration `0004`); the run driver parks every real suspension — a `FlowEngine.annotateWaiting` declaration (`approval`/`quota`/token, issue #31) when present, else `timer` with the earliest clock deadline, else `event` — and wakes on resume, so sweepers observe production suspensions; an annotation is consumed once its awaited deferred resolves, so a later suspension parks under its own reason and timer `wakeAt` instead of a stale replayed one (issue #42) |
| Retry policy | `Engine.RetryPolicy`: data-shaped policy, pure `nextDelay`, `decideEffect` decision point driven by the persisted attempt count, and an `expirationMs` schedule-to-close bound (issue #36) measured from the durably persisted first-attempt start via the driver's `activityRetryOrigin`, so the wall-clock budget survives park/resume and process death (issue #45). The retry verdict is durable too: a persisted `failed` attempt row replays by rethrowing the persisted domain failure (never `AttemptAdmissionRejected`) and the attempt counter resumes from the driver's `activityLatestAttempt`, so a `nonRetryable` failure matches on resume without an extra dispatch and the backoff ladder is not re-slept (issue #59, Temporal mutable-state parity). When attempt 1 itself was pruned, `activityRetryOrigin` degrades to the earliest surviving attempt row; only when no row survives does the engine restart the budget from the current clock, with a logged warning (issue #69) |
| Lifecycle journal channel | Engine-store lifecycle events (run decisions, attempt lifecycle, deferred completions, clock schedules, interruptions, cache provenance/conflicts) are written with `emitDurable` — undroppable; attempt lifecycle appends are owner-fenced and a zombie owner self-interrupts on `fence_lost` |
| Fault harness | `Journal.Notifying.wrap` / `layer` for interstitial crash and fence-loss injection around any Effect service |
| Public error contract | `EngineStore.Errors` barrel-exports `FlowCycleDetected`, `CacheConflictDetected`, and `AttemptAdmissionRejected`; every one carries a stable `code` literal |
| Time travel utilities | Replay projections, memory/SQL time-travel stores, fork, rewind, compensation, recovery, and tier-aware retry |

## Implemented contracts with no production implementation

| Contract | What is missing |
| --- | --- |
| `StepBoundary` | A host layer that enforces read/write sets, detects changed paths, captures outputs, and replays those outputs |
| Cross-host liveness | `EngineStore.Options.isAlive` is application-supplied |
| `RunCatalog` | A durable workspace run list/watch; static and memory implementations ship |
| Browser Jujutsu and PTY | Typed unavailable implementations ship |
| Edge Shell | Typed unavailable by default; optional remote sandbox adapters ship |

## Planned or incomplete integration

- A public static planner/action-graph API that computes all keys and cache hits before execution.
- Production hermetic action execution and output materialization for cross-run caching.
- A packaged production layer that composes database, migrations, journal stores, durable deferred/clock state, kernel, Host, and engine.
- Event-driven `resumeSignal`; suspension polling remains the fallback.
- Journal checkpointing/compaction for unbounded histories.
- Plugin dispatch at the engine seams (`resolveRetry`, `classifyError`, `cacheInconsistency`, `resolveShareability`, `waitStart`/`wake`) — the kernel ships, the core call sites still use their built-in defaults.
- Graph-level failure policies such as quarantine or continue-on-failure.
- Detached child flow construction and lifecycle policy.
- Automatic creation of time-travel snapshots, lineage edges, and boundary records from ordinary engine execution.
- **Postgres/PGlite dialect parity — an accepted gap, not scheduled (issue #78).** Both shipped `Database` backends are SQLite (`@effect/sql-sqlite-node`; sqlite-wasm OPFS in the browser) and the journal migration ladder is SQLite-flavoured DDL, so a smithers workspace already on PGlite or Postgres cannot take stage 1 of the documented cutover. What did land is the dialect-blind write-retry seam: `Database.make` takes any `SqlClient`, and classification now covers the Postgres transient SQLSTATEs (`40001`/`40P01`/`55P03` and PGlite's text forms) as well as the SQLite codes, normalized onto the same `busy` category, so a hand-supplied `PgClient` is degraded rather than silently unprotected. The remaining plan (pg/pglite layers, a dialect-parameterized ladder, the suites run against PGlite in CI) is written out as new gap 4 in [`smithers-replacement-gaps.md`](smithers-replacement-gaps.md).
- A fully runnable engine-store deployment for Cloudflare Workers.
- Fully durable serverless deferreds and clocks on Vercel.

## Important integration cautions

- `EngineStore` is currently Node-specific because it uses `process.pid` and `node:crypto`.
- `SqlTimeTravelStore.createFork` materializes executable state from the
  parent's current persisted snapshot and attempts, and records the lineage
  edge on `flows_runs.parent_run_id`. Those records are not historical per
  journal frame.
- The time-travel package reads cache keys from effect-boundary metadata. Callers recording those boundaries must use the same cache address convention as the cache producer.
- Flow registrations and active fibers are scoped in memory. A restarted process must re-register handlers before driving stored runs.
- The `Database.write` retry classifier is SQLite-oriented even though the Vercel store adapter can wrap a PostgreSQL `SqlClient`.

The package is unreleased. Treat these boundaries as source-level contracts, not compatibility promises.

For the smithers-engine cutover view of this status — what is closed, partial, and missing versus the smithers internal engine — see [smithers-replacement-gaps](smithers-replacement-gaps.md).
