# `@flows/workflow-engine`

This page is the public API reference for typed workflows, recorded activities, durable deferreds/clocks/queues, the engine service, and generated RPC/HTTP workflow façades. It contains no persistence implementation beyond the in-memory layer.

## `Workflow`

`Workflow.make(tag, options)` accepts struct payload fields, success/error schemas, an optional `idempotencyKey`, annotations, and a suspended retry schedule. The returned definition exposes:

- `execute(payload, { executionId?, discard? })`
- `poll(executionId)`
- `interrupt(executionId)` and `resume(executionId)`
- `executionId(payload)`
- `toLayer(handler)`
- `annotate` and `annotateMerge`
- `withCompensation`

`ExecutionIdRequired` is raised as a defect when neither explicit nor derived identity exists. Result exports include `Complete`, `Suspended`, `Result`, encoded schemas, `intoResult`, and `wrapActivityResult`. Scope helpers are `scope`, `provideScope`, `addFinalizer`, `withCompensation`, and `suspend`. Policy references are `CaptureDefects` and `SuspendOnFailure`.

## `Activity`

`Activity.make(options)` defines a named effect with success/error schemas, `tier`, idempotency identity, metadata, annotations, and optional infrastructure-interrupt schedule.

| Export | Purpose |
| --- | --- |
| `Tier` | `sealed`, `compensable`, or `irreversible` |
| `InfraInterrupt` | Host-loss/rebalancing marker |
| `IrreversibleRetryRequiresIdempotencyKey` | Unsafe retry failure |
| `retry(effect, options)` | Effect retry with durable attempt context |
| `CurrentAttempt`, `CurrentOrdinal` | Runtime references |
| `idempotencyKey(name, options?)` | Internal run-local ordinal key |
| `raceAll(name, activities)` | Durable activity race |

An activity is itself an `Effect`; `activity.execute` bypasses engine recording and should normally be used only by engine implementations.

## Durable primitives

| Namespace | Public surface |
| --- | --- |
| `DurableDeferred` | `make`, `await`, `into`, `raceAll`, branded token parsing/creation, and `done`/`succeed`/`fail`/`failCause` completion |
| `DurableClock` | `make({ name, duration })` and `sleep({ name, duration, inMemoryThreshold? })` |
| `DurableQueue` | `make`, `process`, `makeWorker`, and `worker` over Effect `PersistedQueue` |

Deferred tokens encode workflow name, execution ID, and deferred name so another process can complete the correct durable address.

## `WorkflowEngine`

`WorkflowEngine` is the service tag for registration, execution, polling, safe/unsafe interruption, resume, activity execution, deferred lookup/completion, and clock scheduling. `WorkflowInstance` holds one execution’s mutable frontier state.

`Encoded` is the implementation interface; `makeUnsafe(encoded)` wraps it as the public service. `layerMemory` provides the local implementation used in examples and tests. `SnapshotBoundary` is the host snapshot contract used by compensable activities.

## Workflow proxies

`WorkflowProxy.toRpcGroup` and `toHttpApiGroup` derive Effect RPC or HTTP definitions from a non-empty workflow list. `WorkflowProxyServer.layerRpcHandlers` and `layerHttpApi` bind registered workflow operations to those façades.

These modules expose workflow transport only; they do not ship a server, router, authentication policy, or durable engine.

See [Getting started](../guides/getting-started.md), [Writing a workflow](../guides/writing-a-workflow.md), and [Determinism and replay](../concepts/determinism-and-replay.md).
