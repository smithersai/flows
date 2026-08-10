# `@smthrs/journal`

This page is the public API reference for durable events, run ownership, activity attempts, and content-cache rows. The package stores engine facts; flow orchestration is implemented by `@smthrs/engine-store`.

## Journal events

`JournalEvent` exports branded `RunId`, `Seq`, `SourceId`, and `SourceSeq` schemas, plus:

- `Input`: producer event with run/source identity, event type, payload, and optional metadata.
- `Entry`: committed input plus canonical sequence, event ID, and timestamp.
- `makeEventId(runId, sourceId, sourceSeq)`: stable producer-idempotency address.

`Journal` exports the service tag and these operations:

| Operation | Result |
| --- | --- |
| `emitLossy(input)` | Optimistic telemetry receipt; `Dropped` and eviction are accepted outcomes |
| `emitDurable(input)` | `Accepted` or `Duplicate` receipt whose `seq` is already committed |
| `entries({ runId, after?, limit })` | Durable page and `hasMore` |
| `stream({ runId, afterSequence? })` | Replay-then-follow stream |
| `changes` | Scoped subscription to locally committed entries |
| `project(projection, options)` | Stream of accumulated projection states |
| `flush` | Wait until currently accepted queued events commit |

`make`, `makeNoop`, and `layerNoop` construct custom or closed implementations. `JournalError` has stable codes; `OverflowPolicy` is `reject`, `drop-newest`, or `drop-oldest`.

## SQL journal

`SqlJournal.layer(options)` provides the bounded telemetry writer and inline durable writer over `Database`. Options are `capacity`, `overflow`, and optional `batchSize`, `sourceEventCache`, and `redact`.

### Source-event index bound

`sourceEventCache` (default `4096`) bounds the in-process producer-idempotency index. The database unique constraint remains authoritative, so eviction changes only whether a retry is recognized before the write transaction. Resident memory and startup decode are O(`sourceEventCache`), not O(total events).

### Sequence allocation

`emitDurable` allocates both sequences inside the writer's transaction (`MAX(seq) + 1`, taking the in-memory clock as a floor) and inserts the row before returning, so the returned `seq` is already committed. `(run_id, source_id, source_seq)` deduplication is unchanged: an exact producer retry returns `Duplicate` with `status: "committed"`, and a reused producer sequence carrying different content fails with `idempotency_conflict`. Use it wherever a caller acts on the returned sequence — lifecycle finalization, cross-process supervisors, or any deployment where a second writer may open the same run. A durable boundary must not advance the run or expose its result until this commit returns.

### `transact` — one transaction for the entry and the state it describes

Committing an entry makes that entry durable; it does not by itself make flows' whole view crash-consistent, because the executable state lives in `RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState`. `transact` closes that seam:

```ts
yield* journal.transact(Effect.gen(function*() {
  const finished = yield* attempts.finish(row, owner)
  if (finished._tag !== "Finished") return false
  yield* journal.emitDurable(attemptFinished, owner)
  return true
}))
```

Those stores write through the same `Database`, so their writes join this transaction as savepoints: the row and its lifecycle entry either both commit or both roll back. Engine-store uses it for every lifecycle pair it writes, which is what makes the journal an account of record rather than a best-effort echo. The prior art is Temporal, which closes mutable state into a mutation plus event batches and submits them as one persistence request (`reference/temporal/service/history/workflow/transaction_impl.go`).

Three properties matter to callers:

- **Publication follows COMMIT.** Inside a transaction, `emitDurable` returning means a savepoint was released. The `changes`/`stream` publish and the in-process producer index update are parked until the outermost transaction commits, so a subscriber never sees an entry that later rolls back, and a rolled-back producer identity stays re-emittable instead of deduplicating against a sequence that does not exist.
- **Only storage work belongs inside.** The transaction is held for its whole body: no flow bodies, host calls, or `flush` (which waits on the lossy writer and would deadlock against the open transaction).
- **Nesting is a savepoint.** An inner `transact` defers its settlements to the outermost commit.

A crash before COMMIT still loses the whole unit, so work that had already run — an activity body, for instance — re-executes on the next drive. And no local transaction makes a remote effect atomic, so external effects still need idempotency keys, fencing tokens, or compensation.

Stated deviation from smithers (`packages/db/src/adapter.js`), which allocates under `BEGIN IMMEDIATE`: the SQLite backends we ship give Effect's SQL client no `beginTransaction` hook, so `Database.write` opens the default DEFERRED transaction. The floor read holds a shared lock and the INSERT upgrades it; under WAL a concurrent writer makes that upgrade fail `SQLITE_BUSY_SNAPSHOT`, which the database package classifies as retryable and replays the whole transaction — floor read included — against the committed snapshot. Allocation is therefore conflict-free by retry, not by lock escalation, and `packages/journal/test/JournalDurable.test.ts` proves it with two connections writing one run concurrently and with a cold-restart floor case.

Because that transaction both replays and can abort at COMMIT, `emitDurable` mutates the in-memory clock and publishes to `changes`/the per-run wake PubSub strictly *after* the transaction returns, exactly as the queued path publishes outside `persistBatch`. A rolled-back write is never observable to a subscriber and never becomes an allocation floor.

Every write funnels through one preparation step, and that step redacts: `payload` and `meta` are scrubbed by `Redaction.make()` before they are encoded, so no channel can persist a credential. Fields whose names read as credentials (`apiKey`, `authorization`, `cookie`, `token`, `password`, `secret`, and separator/case variants) are replaced wholesale; provider keys, bearer tokens, and `SECRET=value` assignments are replaced inside any string. Rows are permanent and are replayed verbatim to sync subscribers and time-travel consumers, so redaction on write is the only place it can be enforced once. Pass `redact: Redaction.makeNoop()` to `SqlJournal.layer` to persist payloads verbatim by choice.

Redaction stops at the journal. It is an **observability** concern, and journal rows exist to be read — by sync subscribers, by time-travel consumers, by a support bundle. The other three stores hold *executable* state and are deliberately not redacted: `RunStore.state_json` is decoded and re-entered on every resume, an `AttemptStore` checkpoint is handed back to the retrying step, an outcome is returned verbatim as the replayed result, and a `CacheStore` hit *is* the step's result. A name-suffix redactor there is silent corruption, not defence: a legitimate `pageToken` resumes as `"[REDACTED]"` and the flow reads the wrong page, and a non-string field like `clientSecret: { … }` becomes a string, so schema decode of the persisted state dies and the run is undrivable (issue #72). Those stores therefore take no `redact` option at all — `RunStore.layer`, `AttemptStore.layer`, and `CacheStore.layer` round-trip their columns byte-for-byte.

A value that must never reach durable executable state is a typed boundary, not a guess made at the storage seam: model it as a `Redacted` field in the flow's own state schema, so the encoder drops it by declaration and the decoder knows it is absent. For rendering a stored column to a human, `Redaction.redactJsonString` scrubs an already-encoded JSON string at the display surface, leaving the durable row untouched.

The two channels also fail independently, and neither failure is permanent. A batch the optimistic writer cannot persist is lost and reported — to the `flush` waiters that covered it, to live `stream` consumers that were following when it happened, and, if nobody was waiting, to the next `flush` — but the writer fiber survives it. Each loss is reported once; a later `flush` with nothing outstanding succeeds, while entries queued behind the lost batch stay outstanding — only the destroyed batch leaves the pending set, so a subsequent `flush` still waits for them instead of vouching for unpersisted work — so a single transient outage cannot stall the durable delivery paths in `engine-store` that call `flush` after `emitDurable`. `emitDurable` was never gated by it: it opens its own transaction inline, so the lossless lifecycle channel keeps working as soon as the database is healthy again.

### Migrations

`Migrations.run` creates the complete journal, run, attempt, cache, deferred, and clock schema. `Migrations.layer` runs it as a layer dependency. The repository is unreleased, so there is one authoritative initial schema rather than compatibility migrations for obsolete internal versions.

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

`Ownership.OwnerId` contains `hostId`, `pid`, and `nonce`. `LivenessEvidence` records observer and observation time. `heartbeatLoop`, `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, and `heartbeatWriteTolerance` support scoped ownership maintenance. The loop interrupts its owner immediately on durable evidence that the fence is gone (any outcome other than `Updated`), but tolerates failed heartbeat *writes* for `heartbeatWriteTolerance`. That budget is `heartbeatStaleAfter` minus `heartbeatSkewAllowance` minus one heartbeat tick. The allowance is explicit because the owner stamps the heartbeat from its own clock while the stealer judges it against *its* clock, so the hosts' offset is subtracted straight from the owner's margin; the tick covers the budget only being re-evaluated once per pulse. Within the allowance the owner always stops executing side effects before a steal can be admitted. Beyond it the lease is bounded, not guaranteed: durable writes stay safe because the ownership compare-and-set fences them, but non-durable external side effects can overlap — inherent to any wall-clock lease, and a caller that cannot tolerate overlap needs a fencing token at the side effect itself. A successful pulse re-arms that window.

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

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance. `evict(keyDigest, { ifRecordedBy })` deletes only while the row still carries that `(runId, eventSeq)` pair — both halves, since sequence numbers are per-run and collide across runs routinely. Whether the insert conflicted and whether the fenced delete hit are read through [`Database.affectedRows`](database.md#database) rather than a driver-specific `changes` cast, so the outcomes hold on every backend (issue #134).

Both stores export SQL `make`/`layer` plus no-op test seams.

## Coordination and tests

`RunCoordinator.make({ drain })` deduplicates in-process work by key and exposes `active`, `run`, `wake`, and `interrupt` around scoped fibers. It is not distributed ownership; use `RunStore` for that.

`Projection.make` is an identity constructor for `{ name, initial, reduce }`. `TestJournal.layer(options?)` — imported from `@smthrs/journal/test/TestJournal`, not the root — composes migrations and all SQL stores over in-memory SQLite.

## Entry points

The root holds the stores and their contracts, all written against the driver-neutral `@smthrs/database` service, and it bundles for the browser (`npm run browser`). The test doubles bind a Node SQLite database and are therefore imported from `@smthrs/journal/test/TestJournal` and `@smthrs/journal/test/Notifying`. See [browser support](../architecture/browser-support.md).

See [Journal semantics](../concepts/journal.md), [Concurrency](../concepts/concurrency.md), and the [`@smthrs/engine-store` reference](engine-store.md).
