# `@smithers/journal`

This page is the public API reference for durable events, run ownership, activity attempts, and content-cache rows. The package stores engine facts; flow orchestration is implemented by `@smithers/engine-store`.

## Journal events

`JournalEvent` exports branded `RunId`, `Seq`, `SourceId`, and `SourceSeq` schemas, plus:

- `Input`: producer event with run/source identity, event type, payload, and optional metadata.
- `Entry`: committed input plus canonical sequence, event ID, and timestamp.
- `makeEventId(runId, sourceId, sourceSeq)`: stable producer-idempotency address.

`Journal` exports the service tag and these operations:

| Operation | Result |
| --- | --- |
| `emit(input)` | `Accepted`, `Duplicate`, or `Dropped` receipt |
| `emitDurable(input)` | `Accepted` or `Duplicate` receipt whose `seq` is already committed |
| `entries({ runId, after?, limit })` | Durable page and `hasMore` |
| `stream({ runId, afterSequence? })` | Replay-then-follow stream |
| `changes` | Scoped subscription to locally committed entries |
| `project(projection, options)` | Stream of accumulated projection states |
| `flush` | Wait until currently accepted queued events commit |

`make`, `makeNoop`, and `layerNoop` construct custom or closed implementations. `JournalError` has stable codes; `OverflowPolicy` is `reject`, `drop-newest`, or `drop-oldest`.

## SQL journal

`SqlJournal.layer(options)` provides the bounded batching implementation over `Database`. Options are `capacity`, `overflow`, optional `batchSize`, optional `allocation`, and optional `sourceEventCache`.

### Source-event index bound

`sourceEventCache` (default `4096`) bounds the in-process index that answers `emit` idempotency from memory. Startup loads only the most recent `sourceEventCache` events (`ORDER BY emitted_at_ms DESC … LIMIT`), and admission evicts the least-recently-added *committed* entry once the bound is exceeded; uncommitted entries are never evicted, because the database does not hold them yet. The index is a cache, not the authority: the writer re-checks `(run_id, source_id, source_seq)` under its unique constraint on every insert, so an evicted event that is re-emitted is still deduplicated durably (no second row) and still fails with `idempotency_conflict` on changed content. The only degradation past the window is a memory-path receipt reported as `Accepted` rather than `Duplicate`, the same behaviour the `drop-oldest` eviction path already had. Resident memory and startup decode are therefore O(`sourceEventCache`), not O(total events ever written).

### Sequence allocation

`allocation` selects where the canonical per-run `seq` is assigned.

| Mode | `emit` behaviour | Writers per run |
| --- | --- | --- |
| `"memory"` (default) | Allocates in process memory and queues the write. The receipt is optimistic: a crash can lose an accepted-but-unwritten event. | One process |
| `"sql"` | `emit` is `emitDurable`. | Any number |

`emitDurable` allocates both sequences inside the writer's transaction (`MAX(seq) + 1`, taking the in-memory clock as a floor) and inserts the row before returning, so the returned `seq` is already committed. `(run_id, source_id, source_seq)` deduplication is unchanged: an exact producer retry returns `Duplicate` with `status: "committed"`, and a reused producer sequence carrying different content fails with `idempotency_conflict`. Use it wherever a caller acts on the returned sequence — lifecycle finalization, cross-process supervisors, or any deployment where a second writer may open the same run.

Stated deviation from smithers (`packages/db/src/adapter.js`), which allocates under `BEGIN IMMEDIATE`: the SQLite backends we ship give Effect's SQL client no `beginTransaction` hook, so `Database.write` opens the default DEFERRED transaction. The floor read holds a shared lock and the INSERT upgrades it; under WAL a concurrent writer makes that upgrade fail `SQLITE_BUSY_SNAPSHOT`, which the database package classifies as retryable and replays the whole transaction — floor read included — against the committed snapshot. Allocation is therefore conflict-free by retry, not by lock escalation, and `packages/journal/test/JournalDurable.test.ts` proves it with two connections writing one run concurrently and with a cold-restart floor case.

Because that transaction both replays and can abort at COMMIT, `emitDurable` mutates the in-memory clock and publishes to `changes`/the per-run wake PubSub strictly *after* the transaction returns, exactly as the queued path publishes outside `persistBatch`. A rolled-back write is never observable to a subscriber and never becomes an allocation floor.

The two channels also fail independently. When the optimistic writer fiber dies, the queued channel is finished — `emitLossy`, `emit` under memory allocation, `flush`, and live `stream` consumers all fail with `sink_failed`, because nothing will drain that queue again and hiding the loss would be worse. `emitDurable` is not gated by it: it opens its own transaction inline, so the lossless lifecycle channel keeps working as soon as the database is healthy again. A transient telemetry-batch failure can no longer revoke the lossless-emit guarantee for the life of the process.

### Migrations

`Migrations.run` creates the journal, sequence, run, attempt, cache, and supporting tables. `Migrations.layer` runs it as a layer dependency. Apply it before store construction.

`Migrations.runThrough(name)` applies the ladder only up to and including `name` (`Migrations.names` lists them in order). A database in the field is always some prefix of the ladder *with rows in it*, so that is the state schema evolution has to survive: migrate to a prefix, populate, then run the rest. `packages/journal/test/Migrations.test.ts` does exactly that across `0003`/`0004`, which `Migrations.run` alone could only ever apply to an empty table — the one case SQLite never rejects.

## Run ownership

`RunStore` exports:

- `RunStatus`: `pending`, `running`, `suspended`, `completed`, `failed`, or `cancelled`.
- `RunRow`, `RunSnapshot`, `CreateOptions`, and `TransitionGuard`.
- fenced `create`, `get`, `claim`, `claimAndOwn`, `activate`, `abandonClaim`, `recoverClaim`, `heartbeat`, `transitionOwned`, and `steal`, plus unfenced `requestCancel`.
- tagged outcome unions for every compare-and-set operation.
- `make`, `layer`, `makeNoop`, and `layerNoop`.

### Run metadata: columns versus `state_json`

`flows_runs` carries exactly two metadata columns beyond identity, lifecycle, and ownership:

| Column | Why it is a column |
| --- | --- |
| `cancel_requested_at_ms` | It participates in a compare-and-swap. `transitionOwned(..., { cancelRequested: "absent" })` compiles the predicate into the same `UPDATE` as the ownership fence, so a cancellation request cannot slip between a read and a terminal write. |
| `parent_run_id` | Lineage is walked in SQL. A recursive CTE over `parent_run_id` answers ancestry questions that a JSON side-channel would force into decode-then-filter. |

Everything else a harness records about a run — workflow name and hash, cancel attribution, pause and hijack requests, VCS coordinates, config — stays in `state_json`. That is the intended extension point, not a workaround: those fields are read with the row, never guarded on, and adding a column per harness concept would make the schema a union of its consumers. `state_json` is checked to be valid JSON, and `transitionOwned` replaces it atomically with the status change.

When a `state_json` field does need to be scanned, index the expression rather than promoting the column:

```sql
CREATE INDEX flows_runs_workflow_name_idx
ON flows_runs (json_extract(state_json, '$.workflowName'));

SELECT run_id FROM flows_runs
WHERE json_extract(state_json, '$.workflowName') = 'deploy';
```

Promote a field to a column only when it must appear in a CAS guard. `TransitionGuard` is the seam for that: new guarded metadata extends the interface and the single `UPDATE`, rather than adding a transition variant per rule.

`requestCancel(runId, nowMs)` records the request without an owner fence — any observer may ask, and the owner decides at its next guarded transition. It returns `CancelRequested`, `AlreadyRequested` (with the original request time, which is never overwritten), or `NotFound`. A guarded transition that loses only to its guard returns `GuardFailed`, distinct from `FenceLost`.

`Ownership.OwnerId` contains `hostId`, `pid`, and `nonce`. `LivenessEvidence` records observer and observation time. `heartbeatLoop`, `heartbeatInterval`, and `heartbeatStaleAfter` support scoped ownership maintenance.

## Attempts and cache

`AttemptStore` addresses rows with `AttemptId`, exposes `put`, `get`, `heartbeat`, `finish`, and `patch`, and returns explicit fenced outcome unions.

`make`/`layer` use the default policy; `makeWith(options)`/`layerWith(options)` take an `Options`:

| Option | Default | Effect |
| --- | --- | --- |
| `inProgressStates` | `["running"]` | States the store treats as still in progress. `heartbeat` and `finish` fence on membership, and `finish` refuses them as targets. A harness whose vocabulary is `in-progress` configures it here instead of translating at the boundary. |
| `maxCheckpointBytes` | `1048576` | Largest encoded checkpoint accepted. Raise it when the durable mid-attempt checkpoint is an agent session rather than a cursor. |
| `putMode` | `"insert"` | `"insert"` is first-writer-wins: a re-put with different content reports `Conflict`. `"upsert"` overwrites the row and reports `Upserted`. Both keep the run-ownership fence. |

`finish` COALESCEs `error_json`, `outcome_json`, and `meta_json`: a value recorded mid-flight by `put` or `patch` survives a terminal claim that omits it, and supplying one replaces it. Only `put`'s upsert rewrites those columns unconditionally, because an upsert restates the whole row.

`patch(id, fields)` is the unfenced surface for opaque fields — checkpoint, error, outcome, and metadata — and never moves `state`, `started_at_ms`, or `finished_at_ms`. Omitted fields are left as recorded. It returns `Patched` or `NotFound`. Fields such as response text, worktree pointers, or cache flags belong in `meta`; the fenced lifecycle stays with `put`/`heartbeat`/`finish`.

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance.

Both stores export SQL `make`/`layer` plus no-op test seams.

## Coordination and tests

`RunCoordinator.make({ drain })` deduplicates in-process work by key and exposes `active`, `run`, `wake`, and `interrupt` around scoped fibers. It is not distributed ownership; use `RunStore` for that.

`Projection.make` is an identity constructor for `{ name, initial, reduce }`. `TestJournal.layer(options?)` composes migrations and all SQL stores over in-memory SQLite.

See [Journal semantics](../concepts/journal.md), [Concurrency](../concepts/concurrency.md), and the [`@smithers/engine-store` reference](engine-store.md).
