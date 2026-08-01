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

## The journal is intended to be flows' authoritative logical WAL

The journal is flows' own logical (domain) write-ahead log: run decisions, attempt lifecycle, deferred completions, clock schedules, permission decisions, and cache provenance. It is intended to become the authoritative state history. The SQLite or PostgreSQL WAL underneath it is only the storage durability substrate; it is never read as the application event API.

The rule that follows is that **a durable boundary may not advance the run or expose its result until the corresponding logical WAL entry is committed**. That is what the lifecycle channel is for: `emitDurable` — and `emit` when an owner is passed or the journal is configured with `allocation: "sql"` — allocates inside the write transaction and returns a receipt that is already committed.

A local commit is not remote atomicity. No journal write makes an external effect atomic with it, so effects outside the database still carry idempotency keys, fencing tokens, or a declared compensation.

## Optimistic admission (only telemetry may accept loss)

`SqlJournal.emitLossy`, and `emit` on the default in-memory allocation path with no owner, perform validation, allocate both sequences, and attempt a non-blocking bounded queue offer. They return before SQL commits.

An `Accepted` receipt from that queue means only that the event entered the writer queue. It does not mean the row is durable, and a crash can lose it. `emitLossy` is **lossy by construction and off the critical path**; nothing may be reconstructed from it and no correctness argument may cite it. Transitional authoritative callers using queued `emit`, such as `JournalGrantStore`, call `journal.flush` and fail closed before activating a decision. New lifecycle callers use `emitDurable`.

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

## State authority today, and the open gap

`RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` hold the **executable authoritative state**. No engine state is derived from journal entries today; the entries explain what happened, the rows decide what happens next.

Engine-store lifecycle events do use `emitDurable`, so they block until committed and cannot be dropped. But the state transition and its lifecycle entry commit in **separate database transactions** — the run-row compare-and-swap, then the decision emit; the attempt write, then the attempt event. A crash between the two leaves durable state that the journal does not explain.

This is a **production blocker**, not a settled design. Execution stays correct across it, because the store rows are authoritative and self-consistent, but audit, sync, and time travel all read the journal as the account of record and can therefore see a hole. Do not read this page as a claim that transitions and entries are atomic, or that state is journal-derived.

The intended resolution is to make the logical WAL authoritative, in one of two shapes:

1. derive the store rows from the log, so there is a single commit; or
2. commit the state projection and its journal entry in one transaction.

## Operational rule

Use `emitLossy` only for telemetry where a drop is acceptable. Put anything that authorizes work or is required for recovery on the durable channel; a transitional queued caller must use `overflow: "reject"`, `flush`, and fail closed before acting. A dropping queue cannot serve as the durable source of permission grants, deferred completion ordering, or time-travel audit.
