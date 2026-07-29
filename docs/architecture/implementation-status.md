# Implementation status

This page distinguishes usable source-backed behavior from contracts and planned integration. It is the authoritative documentation-level status table for this unreleased repository.

## Implemented

| Area | Current behavior |
| --- | --- |
| Workflow definitions | Typed `Workflow.make`, registration layers, explicit or idempotency-derived execution IDs |
| Recorded steps | Typed `Activity.make` with success/error schemas, tiers, metadata, annotations, and encoded exits |
| In-memory runtime | Workflow execution, polling, suspension, resume, interruption, deferreds, clocks, and activity memoization |
| Durable run state | SQL-backed run rows, exact claims, activation fences, heartbeats, stale-owner steal, and terminal transitions |
| Attempt state | Fenced attempt admission, checkpoints up to 1 MiB, first terminal result, and opaque metadata |
| Journal | Bounded optimistic queue, batching, idempotent producer events, paging, replay-then-follow streams, and projections |
| Content addressing | Canonical serialization, SHA-256 content keys, graph-reference resolution, and run-local ordinal keys |
| Cache rows | First-writer-wins content-addressed results with run/sequence provenance |
| Capability kernel | Monotone capability sets, rules, attended/unattended grants, journal-backed decisions, and guarded Host layers |
| Host bundles | Node, Bun, browser/test, Cloudflare, Vercel Edge, and Vercel Node adapters |
| Durable primitives | Deferred completion ordering, absolute clock rows, durable queue API, and attached child workflow wake-up |
| Sync | Read-only catch-up and credit-bounded follow over schema-backed Effect RPC |
| Time travel utilities | Replay projections, memory/SQL time-travel stores, fork, rewind, compensation, recovery, and tier-aware retry |

## Implemented contracts with no production implementation

| Contract | What is missing |
| --- | --- |
| `StepBoundary` | A host layer that enforces read/write sets, detects changed paths, captures outputs, and replays those outputs |
| `DurableEngineState` | A SQL or hosted implementation for deferred completions and clock deadlines; only `makeMemory`/`layerMemory` ship |
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
- Graph-level failure policies such as quarantine or continue-on-failure.
- Detached child workflow construction and lifecycle policy.
- Automatic creation of time-travel snapshots, lineage edges, and boundary records from ordinary engine execution.
- A fully runnable engine-store deployment for Cloudflare Workers.
- Fully durable serverless deferreds and clocks on Vercel.

## Important integration cautions

- `EngineStore` is currently Node-specific because it uses `process.pid` and `node:crypto`.
- `SqlTimeTravelStore.createFork` creates a low-level run row and copies journal entries, but it does not create the versioned `EngineStore` persisted state required to execute that fork directly.
- The time-travel package reads cache keys from effect-boundary metadata. Callers recording those boundaries must use the same cache address convention as the cache producer.
- Workflow registrations and active fibers are scoped in memory. A restarted process must re-register handlers before driving stored runs.
- The `Database.write` retry classifier is SQLite-oriented even though the Vercel store adapter can wrap a PostgreSQL `SqlClient`.

The package is unreleased. Treat these boundaries as source-level contracts, not compatibility promises.
