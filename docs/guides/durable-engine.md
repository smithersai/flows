# Assembling a durable engine

This guide describes the services required by `@smthrs/engine-store-next` and gives a local SQL-backed composition pattern. It also identifies which services must be replaced before a multi-process deployment is durable.

## Required services

`EngineStore.make` requires:

- `Journal`, `RunStore`, `AttemptStore`, and `CacheStore`
- `DurableEngineState`
- kernel `Jj`
- `StepBoundary`
- an Effect `Scope`

`TestStores.layer()` supplies the four SQL services — journal, run, attempt, and cache — over ONE in-memory SQLite database. It is useful for integration tests, not restart durability:

```ts
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store-next"
import * as TestStores from "@smthrs/engine-store-next/test/TestStores"
import { Jj } from "@smthrs/kernel-next"
import { Effect, Layer } from "effect"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "local" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const Requirements = Layer.mergeAll(
  TestStores.layer(),
  DurableEngineState.layerMemory,
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj, jj)
)

const EngineLayer = EngineStore.layer({
    owner: { hostId: "local-worker" },
    journalSource: "local-engine",
    isAlive: () => Effect.succeed(false)
}).pipe(Layer.provide(Requirements))
```

`EngineLayer` provides the `FlowEngine` service. Merge it with flow handler layers, then run flow operations inside the resulting layer scope.

## Persistent SQL composition

For a persistent deployment:

1. create a compatible Effect `SqlClient`,
2. wrap it with `DurableWriter.make` or a runtime adapter,
3. run `Journal.Migrations`,
4. construct `SqlJournal`, `RunStore`, `AttemptStore`, and `CacheStore` from that database,
5. construct `DurableEngineState.layer` from the same migrated database,
6. provide the resulting services to `EngineStore.layer`.

Migrations must complete before any store service is exposed. `DurableWriter.write` wraps a SQL transaction and retries retryable SQLite write failures; non-SQLite drivers retain their own transaction behavior.

## Services still owned by the application

Use `DurableEngineState.layer` for process-restart durability.
`DurableEngineState.layerMemory` remains intended for tests. On flow
registration, the SQL implementation re-arms every pending future or overdue
clock and re-delivers wakes for stored completions through the normal run
claim path.

`StepBoundary.layerTest` does not create a sandbox. `StepBoundary.layer` can
measure declared paths and materialize outputs, but cannot observe writes
elsewhere in the tree, so its results are not admitted to the shared cache.
Supply a stronger boundary that enforces declared writes and returns
`wholeTreeWritesVerified: true` before admitting cross-run cache entries.

`EngineStore` mints its owner identity through the `OwnerIdentity` service rather than reading `node:crypto.randomUUID` and `process.pid` directly, so the composition itself is edge-safe: the default draws an incarnation number from `Random` where the platform has no process, and `OwnerIdentity.layerConstant` pins the whole token where a host already holds a lease. What is still **Planned** is a browser SQL client behind the `DurableWriter` contract — without one there is nothing for the composition to run against off Node.

## Ownership and liveness

Give each worker a stable `hostId`; the engine adds process identity and a random nonce for each engine instance. `isAlive` must return trustworthy evidence about another owner. Returning `false` unconditionally, as in tests, permits immediate takeover and is unsafe in a real multi-worker deployment.

## Wake behavior

Deferred and clock completion schedule a resume. A committed journal-driven `resumeSignal` is not implemented, so suspended execution can also rely on the flow engine’s polling schedule.

See the [`@smthrs/engine-store-next` reference](../reference/engine-store.md), [Journal](../concepts/journal.md), and [Implementation status](../architecture/implementation-status.md).
