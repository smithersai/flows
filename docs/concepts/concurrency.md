# Concurrency

This page explains concurrency that exists in flow handlers, activities, durable queues, ownership, and journal admission. It separates those mechanisms from the planned static graph scheduler.

## Handler concurrency

Use Effect combinators to express dependencies and concurrency:

```ts
const [checked, tested] = yield* Effect.all(
  [typecheck, test],
  { concurrency: 2 }
)
```

The enclosing flow handler does not complete until both effects complete. Error and interruption behavior follows `Effect.all`; Smithers Flows does not add an implicit “continue unrelated nodes” policy.

Activities receive stable per-run ordinals from the engine. The ordinal is part of an ordinal step key, so changing branch structure or evaluation order can change identity. For cross-run cache reuse, declare a content identity instead of relying on an ordinal.

## Durable races

`Activity.raceAll` and `DurableDeferred.raceAll` preserve the flow abstractions while racing alternatives. They are distinct from a planned graph-level race node. Use them only when every loser has acceptable interruption semantics.

## Queue workers

`DurableQueue.worker` accepts a concurrency limit for persisted-queue processing:

```ts
const WorkerLayer = DurableQueue.worker(
  CompileQueue,
  ({ target }) => compile(target),
  { concurrency: 4 }
)
```

Queue persistence comes from Effect’s `PersistedQueueFactory`. The flow offers an item with a deterministic id, awaits a durable deferred token, and resumes after a worker records the handler exit.

## Run and attempt exclusion

Two storage protocols prevent concurrent duplicate ownership:

- `RunStore` fences a run using a claim, owner identity, and heartbeat.
- `AttemptStore` claims an individual `(runId, stepKey, attempt)` before an activity executes.

The protocols reject mismatched owners and stale snapshots. They do not provide distributed locking for arbitrary application resources.

## Journal admission

The SQL journal queue uses optimistic, non-blocking admission. `Journal.emit` can return an `Accepted` receipt before the batch is flushed durably. Capacity limits bound queued events and bytes; excess input is rejected instead of waiting indefinitely.

Sequence allocation may produce holes when a reserved event is rejected or a transaction fails. Consumers must treat sequence numbers as ordered cursors, not contiguous counters.

## Planned scheduler

A resource-aware action scheduler, per-node concurrency ceilings, and first-class graph race/failure policies are **Planned**. Today, compose these constraints with Effect primitives and external worker configuration.

See [The action graph](action-graph.md), [Journal](journal.md), and [Failure and retry](failure-and-retry.md).
