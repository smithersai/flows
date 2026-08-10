# Flows and the action graph

This page explains the repository’s Bazel-like properties—content-addressed actions, explicit Effect dependencies, hermetic-boundary contracts, and cached results—while distinguishing them from the static action planner that is not yet implemented.

## The graph that exists today

A flow handler defines dependencies through Effect structure:

```ts
const program = Effect.gen(function*() {
  const source = yield* readSource
  const [types, tests] = yield* Effect.all(
    [typecheck(source), runTests(source)],
    { concurrency: "unbounded" }
  )
  return yield* packageResult(types, tests)
})
```

Sequencing creates dependency edges. `Effect.all` exposes independent branches. `Activity.raceAll` and `DurableDeferred.raceAll` create a persisted race result. Calling another flow creates a child execution dependency.

The graph is therefore explicit in the Effect program but discovered dynamically as the handler runs. There is no public `Node` or static graph value in this repository.

## The Bazel-like action boundary

An activity has the pieces of an action:

| Action property | Current representation |
| --- | --- |
| caller identity | string or canonical JSON object in `Activity.idempotencyKey` |
| runtime layers | `Activity.CacheEnvironment.layers` |
| authority | `Activity.CacheEnvironment.capabilities` |
| declared reads/writes | activity `metadata` decoded as `FileBoundary` |
| output | schema-encoded activity exit and optional `BoundaryEvidence.declaredOutputs` |
| cache address | content-derived `Key`, then its SHA-256 digest in `CacheStore` |

A sealed activity is reusable only when it has an idempotency key, a complete cache environment, and sufficient boundary evidence. Other work receives a run-local key and cannot share results across runs.

## Hermeticity is an evidence gate

The derived `Key` identifies an action but does not enforce hermeticity. Cache admission in `@smthrs/engine-store` additionally requires:

1. activity tier `sealed`;
2. metadata that decodes as `FileBoundary`;
3. boundary mode `hard`;
4. successful `prepare` and `settle`;
5. no expected-set deviation.

The repository ships the contract and a deterministic test layer. A production host implementation that isolates declared reads, detects undeclared writes, captures declared outputs, and restores them on a cache hit is **Planned**.

Without that host layer, the durable engine can still replay an attempt within one run, but it cannot honestly populate the cross-run action cache.

## Graph planning

Resolving graph-local dependency references into digests belongs to the future graph planner. The repository does not publish placeholder graph schemas before that planner exists; when implemented, its declarations and references will live with the planner rather than in `@smthrs/keys`.

## Current scheduling

The runtime schedules fibers, not a persisted static DAG:

- independent Effect branches can run concurrently;
- one `RunCoordinator` drain is active per execution ID in a process;
- distinct execution IDs can be driven concurrently;
- queue worker concurrency is explicit;
- run ownership prevents cross-process duplicate drivers.

There is no global step scheduler, resource pool, critical-path analysis, write-conflict planner, or package-defined concurrency ceiling.

## What a future plan must preserve

The existing contracts constrain a future planner:

- key computation must remain above the encoded storage seam;
- graph-local IDs must remain lookup addresses, not hash material;
- Host implementation identities and capabilities must enter cache key input;
- cache hits must still replay declared outputs through `StepBoundary`;
- planning must not execute Host effects;
- ordinal work must remain run-local.

See [implementation status](../architecture/implementation-status.md) for the planned surfaces.
