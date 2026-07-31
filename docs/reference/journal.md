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

`SqlJournal.layer(options)` provides the bounded batching implementation over `Database`. Options are `capacity`, `overflow`, optional `batchSize`, and optional `allocation`.

### Sequence allocation

`allocation` selects where the canonical per-run `seq` is assigned.

| Mode | `emit` behaviour | Writers per run |
| --- | --- | --- |
| `"memory"` (default) | Allocates in process memory and queues the write. The receipt is optimistic: a crash can lose an accepted-but-unwritten event. | One process |
| `"sql"` | `emit` is `emitDurable`. | Any number |

`emitDurable` allocates both sequences inside the writer's transaction (`MAX(seq) + 1` under the SQLite write lock, taking the in-memory clock as a floor) and inserts the row before returning, so the returned `seq` is already committed. `(run_id, source_id, source_seq)` deduplication is unchanged: an exact producer retry returns `Duplicate` with `status: "committed"`, and a reused producer sequence carrying different content fails with `idempotency_conflict`. Use it wherever a caller acts on the returned sequence — lifecycle finalization, cross-process supervisors, or any deployment where a second writer may open the same run.

### Migrations

`Migrations.run` creates the journal, sequence, run, attempt, cache, and supporting tables. `Migrations.layer` runs it as a layer dependency. Apply it before store construction.

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

`finish` COALESCEs `error_json` and `meta_json`: an error recorded mid-flight survives a terminal claim that omits one, and supplying an error replaces it. `outcome_json` is still written unconditionally, because a terminal outcome is the point of the call.

`patch(id, fields)` is the unfenced surface for opaque fields — checkpoint, error, outcome, and metadata — and never moves `state`, `started_at_ms`, or `finished_at_ms`. Omitted fields are left as recorded. It returns `Patched` or `NotFound`. Fields such as response text, worktree pointers, or cache flags belong in `meta`; the fenced lifecycle stays with `put`/`heartbeat`/`finish`.

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance.

Both stores export SQL `make`/`layer` plus no-op test seams.

## Coordination and tests

`RunCoordinator.make({ drain })` deduplicates in-process work by key and exposes `active`, `run`, `wake`, and `interrupt` around scoped fibers. It is not distributed ownership; use `RunStore` for that.

`Projection.make` is an identity constructor for `{ name, initial, reduce }`. `TestJournal.layer(options?)` composes migrations and all SQL stores over in-memory SQLite.

See [Journal semantics](../concepts/journal.md), [Concurrency](../concepts/concurrency.md), and the [`@smithers/engine-store` reference](engine-store.md).
