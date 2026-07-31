# `@smithers/engine`

This page is the public API reference for typed flows, recorded activities, durable deferreds/clocks/queues, the engine service, and generated RPC/HTTP flow façades. It contains no persistence implementation beyond the in-memory layer.

## `Flow`

`Flow.make(tag, options)` accepts struct payload fields, success/error schemas, an optional `idempotencyKey`, annotations, and a suspended retry schedule. The returned definition exposes:

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

Deferred tokens encode flow name, execution ID, and deferred name so another process can complete the correct durable address.

## `FlowEngine`

`FlowEngine` is the service tag for registration, execution, polling, safe/unsafe interruption, resume, activity execution, deferred lookup/completion, and clock scheduling. `FlowInstance` holds one execution’s mutable frontier state.

`Encoded` is the implementation interface; `makeUnsafe(encoded)` wraps it as the public service. `layerMemory` provides the local implementation used in examples and tests. `SnapshotBoundary` is the host snapshot contract used by compensable activities.

## Flow proxies

`FlowProxy.toRpcGroup` and `toHttpApiGroup` derive Effect RPC or HTTP definitions from a non-empty flow list. `FlowProxyServer.layerRpcHandlers` and `layerHttpApi` bind registered flow operations to those façades.

These modules expose flow transport only; they do not ship a server, router, authentication policy, or durable engine.

See [Getting started](../guides/getting-started.md), [Writing a flow](../guides/writing-a-flow.md), and [Determinism and replay](../concepts/determinism-and-replay.md).
