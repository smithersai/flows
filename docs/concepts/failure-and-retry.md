# Failure and retry

This page describes the retry and terminal-failure rules implemented by workflows, activities, run ownership, and time-travel recovery. It does not define a workflow-wide graph failure scheduler, which is planned.

## Workflow outcomes

A handler completes with an encoded success or expected failure, or returns `Workflow.Suspended`. The durable engine persists the decision and updates the run row. A suspended run may be resumed explicitly, by deferred completion, by a clock, or by completion of an attached child workflow.

`Workflow.SuspendOnFailure` can convert a handler failure into suspension. `Workflow.CaptureDefects` controls whether defects are captured into the workflow result. These references should be set centrally; changing them between replays changes runtime policy.

## Activity attempts

Each durable attempt is addressed by:

```text
(runId, Digest.digest(stepKey), attempt)
```

`Activity.retry` increments `Activity.CurrentAttempt` and delegates scheduling to Effect:

```ts
import { Activity } from "@flows/workflow-engine"
const result = yield* Activity.retry(
  WriteArtifact,
  { times: 4 }
)
```

The engine claims an attempt row before execution. A previously completed attempt is decoded and replayed. A conflicting active attempt is rejected or suspended according to persisted state; it is not silently run twice.

## Tiers

| Tier | Meaning | Retry rule |
| --- | --- | --- |
| `sealed` | Intended to execute inside a declared hermetic boundary | Cacheable only with hard-boundary evidence and no deviation |
| `compensable` | External state may be restored | Engine records snapshot/diff metadata around the attempt |
| `irreversible` | External state cannot be rolled back safely | Any attempt after attempt one requires an idempotency key |

An irreversible retry without an idempotency key fails with `IrreversibleRetryRequiresIdempotencyKey`. A string idempotency key is accepted; a full `StepKey.ContentIdentity` gives callers control over the complete content address.

## Ownership recovery

Runs use a two-stage `claim` then `activate` protocol. Active ownership is fenced by owner identity and heartbeat time. A worker may take over a stale run only with explicit `Ownership.LivenessEvidence`; elapsed wall time alone does not prove that an owner is dead.

The default heartbeat interval is one second and the stale threshold is 30 seconds. These exported values are protocol defaults, not a promise that every deployment can safely infer death at 30 seconds.

## Recovery utilities

`@flows/time-travel` includes:

- `Retry.retry`, which reattempts an operation while blocking unsafe irreversible retries.
- `Recovery.recover`, which completes or rolls back interrupted rewind audits during startup.
- `Compensation`, which assesses and invokes registered rollback handlers.
- `Rewind.rewind`, which performs a fenced, audited rewind protocol.

These utilities require boundary records and store integration supplied by the application. The engine does not create all time-travel records automatically today.

## Planned graph policy

Failure policies such as fail-fast, continue independent branches, quarantine a node, and retry a graph sub-tree are **Planned**. Current concurrency uses ordinary Effect composition, so branch failure semantics are the semantics of the chosen Effect combinator.

See [Concurrency](concurrency.md), [Time travel](time-travel.md), and [Determinism and replay](determinism-and-replay.md).
