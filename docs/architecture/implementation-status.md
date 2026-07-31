# Implementation status

This page distinguishes usable source-backed behavior from contracts and planned integration. It is the authoritative documentation-level status table for this unreleased repository.

## Implemented

| Area | Current behavior |
| --- | --- |
| Flow definitions | Typed `Flow.make`, registration layers, explicit or idempotency-derived execution IDs |
| Recorded steps | Typed `Activity.make` with success/error schemas, tiers, metadata, annotations, and encoded exits |
| In-memory runtime | Flow execution, polling, suspension, resume, interruption, deferreds, clocks, and activity memoization |
| Durable run state | SQL-backed run rows, exact claims, activation fences, heartbeats, stale-owner steal, terminal transitions, lineage (`parent_run_id`), and cancellation requests guarded inside the transition CAS |
| Attempt state | Fenced attempt admission, a configurable in-progress vocabulary and checkpoint cap, optional upsert admission, first terminal result, an unfenced patch surface, and opaque metadata |
| Journal | Bounded optimistic queue, batching, idempotent producer events, paging, replay-then-follow streams, projections, and a multi-writer-safe `emitDurable` that allocates the canonical sequence inside the write transaction |
| Content addressing | Canonical serialization, SHA-256 content keys, graph-reference resolution, and run-local ordinal keys |
| Cache rows | First-writer-wins content-addressed results with run/sequence provenance |
| Capability kernel | Monotone capability sets, rules, attended/unattended grants, journal-backed decisions, and guarded Host layers |
| Host bundles | Node, Bun, browser/test, Cloudflare, Vercel Edge, and Vercel Node adapters |
| Durable primitives | SQL-backed deferred completions and absolute clock rows, restart re-arming and wake recovery, durable queue API, and attached child flow wake-up |
| Sync | Read-only catch-up and credit-bounded follow over schema-backed Effect RPC |
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
- Graph-level failure policies such as quarantine or continue-on-failure.
- Detached child flow construction and lifecycle policy.
- Automatic creation of time-travel snapshots, lineage edges, and boundary records from ordinary engine execution.
- A fully runnable engine-store deployment for Cloudflare Workers.
- Fully durable serverless deferreds and clocks on Vercel.

## Important integration cautions

- `EngineStore` is currently Node-specific because it uses `process.pid` and `node:crypto`.
- `SqlTimeTravelStore.createFork` materializes executable state from the
  parent's current persisted snapshot and attempts. Those records are not
  historical per journal frame.
- The time-travel package reads cache keys from effect-boundary metadata. Callers recording those boundaries must use the same cache address convention as the cache producer.
- Flow registrations and active fibers are scoped in memory. A restarted process must re-register handlers before driving stored runs.
- The `Database.write` retry classifier is SQLite-oriented even though the Vercel store adapter can wrap a PostgreSQL `SqlClient`.

The package is unreleased. Treat these boundaries as source-level contracts, not compatibility promises.
