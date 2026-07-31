# Journal

This page explains the durable event journal and the adjacent run, attempt, and cache stores in `@smithers/journal`. It focuses on semantics and invariants; the [package reference](../reference/journal.md) lists exact exported types.

## Open event envelope

A submitted event contains:

```ts
const input = Schema.decodeUnknownSync(JournalEvent.Input)({
  runId: "run-42",
  sourceId: "worker-a",
  sourceSeq: 0,
  eventType: "example.completed",
  payload: { value: 42 },
  meta: { lineageId: "root" }
})
```

The journal does not define an application-wide event union. `eventType`, `payload`, and `meta` remain open so engine, permission, time-travel, and application events share one ordering substrate.

## Two sequence domains

Each committed entry has:

- `seq` — canonical order within one run;
- `sourceSeq` — producer-local idempotency order within `(runId, sourceId)`.

`makeEventId(runId, sourceId, sourceSeq)` deterministically encodes the producer identity. An exact retry returns `Duplicate` with the original `seq`. Reusing that identity with different event content fails with `idempotency_conflict`.

There is no global order across runs.

## Optimistic admission

`SqlJournal.emit` performs validation, allocates both sequences, and attempts a non-blocking bounded queue offer. It returns before SQL commits.

An `Accepted` receipt means the event entered the writer queue. It does not mean the row is durable. Call `journal.flush` where durability must precede a decision, as `JournalGrantStore` and durable-deferred delivery do.

Overflow policy is explicit:

| Policy | Full queue behavior |
| --- | --- |
| `reject` | fail with `queue_overflow` |
| `drop-newest` | return `Dropped` |
| `drop-oldest` | evict one queued event and return `Accepted` with eviction evidence |

Rejected and dropped admissions consume sequence numbers, so gaps are valid. Consumers must follow declared covered intervals rather than assuming adjacent persisted entries have adjacent sequence values.

## Writer and streams

A single scoped writer persists batches transactionally through `Database.write`. Committed inserts publish to:

- the general `changes` subscription;
- per-run wake channels used by `stream`.

`Journal.stream({ runId, afterSequence })` first reads durable history, then follows committed changes. `project` scans that same stream with an effectful deterministic reducer. Projections have no separate durable state.

## Run store

`RunStore` is synchronous control state, not an event-derived projection. Its compare-and-swap outcomes make contention explicit:

- claim and activation;
- generation-fenced claim abandonment and stale-claim recovery;
- owner heartbeat;
- owned status transition;
- stale-owner steal with liveness evidence.

Ownership decisions write rows directly. Journal events may describe those decisions, but the journal is not consulted to decide who owns a run.

## Attempt store

An attempt address is `(runId, stepKeyDigest, attempt)`. Mutations are fenced by the currently running run owner.

Attempt heartbeats may include a JSON checkpoint up to 1 MiB. Omitting a checkpoint preserves the previous checkpoint. The first fenced terminal transition wins; later finish calls observe `StateChanged`.

## Cache store

`CacheStore` maps a digest to a JSON result, opaque JSON metadata, creation time, and journal provenance. Writes are first-writer-wins:

- equal content → `ExistingSame`;
- different content → `Conflict`;
- no row → `Inserted`.

`@smithers/engine-store` uses `Digest.digest(stepKey)` as the cache address. It admits only hard, deviation-free sealed boundaries.

## Migrations

`Migrations.run` creates:

- `flows_journal_events`;
- `flows_runs`;
- `flows_attempts`;
- `flows_step_cache`;
- migration bookkeeping.

Time-travel tables use a separate migration in `@smithers/time-travel`.

## Operational rule

Use `overflow: "reject"` for events that authorize work or are required for recovery. A dropping journal cannot safely serve as the durable source of permission grants, deferred completion ordering, or time-travel audit.
