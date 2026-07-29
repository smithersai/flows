# Smithers Flows documentation

This documentation covers the unreleased `smithers-flows` durable-execution library: its implemented Effect APIs, durability model, host boundaries, and known gaps. Its scope is limited to the packages in this workspace.

## Reading order

For a first pass, read:

1. [Durable execution model](concepts/durable-execution-model.md)
2. [Workflows and the action graph](concepts/action-graph.md)
3. [Determinism and replay](concepts/determinism-and-replay.md)
4. [Journal](concepts/journal.md)
5. [Step keys and content addressing](concepts/step-keys.md)
6. [Getting started](guides/getting-started.md)
7. [Writing a workflow](guides/writing-a-workflow.md)

Read [implementation status](architecture/implementation-status.md) before choosing a deployment architecture. It distinguishes working library surfaces from planned integration work.

## Concepts

- [Durable execution model](concepts/durable-execution-model.md) — executions, activities, suspension, ownership, and recovery.
- [Workflows and the action graph](concepts/action-graph.md) — dependency structure and the current limit of Bazel-like planning.
- [Determinism and replay](concepts/determinism-and-replay.md) — replay-safe workflow bodies and recorded effect boundaries.
- [Journal](concepts/journal.md) — optimistic admission, durable order, projections, and run state.
- [Step keys and content addressing](concepts/step-keys.md) — canonical serialization, content keys, and ordinal keys.
- [Effect integration and error taxonomy](concepts/effect-integration.md) — services, layers, schemas, and the three effect tiers.
- [Failure and retry policy](concepts/failure-and-retry.md) — typed failures, infrastructure interruption, and tier-aware retry.
- [Concurrency](concepts/concurrency.md) — fibers, durable races, queues, and run coordination.
- [Host adapters and capability enforcement](concepts/hosts-and-capabilities.md) — the closed Host surface and permission-decorated layers.
- [Time travel](concepts/time-travel.md) — frames, replay, fork, rewind, compensation, and recovery.
- [Sync](concepts/sync.md) — read-only journal catch-up and following over Effect RPC.
- [Subworkflows](concepts/subworkflows.md) — current attached-child behavior and unsupported detached children.

## Guides

- [Getting started](guides/getting-started.md)
- [Writing a workflow](guides/writing-a-workflow.md)
- [Using the durable engine](guides/durable-engine.md)
- [Testing](guides/testing.md)
- [Cloudflare](guides/cloudflare.md)
- [Vercel](guides/vercel.md)

## Package reference

- [`@flows/database`](reference/database.md)
- [`@flows/host`](reference/host.md)
- [`@flows/journal`](reference/journal.md)
- [`@flows/kernel`](reference/kernel.md)
- [`@flows/keys`](reference/keys.md)
- [`@flows/workflow-engine`](reference/workflow-engine.md)
- [`@flows/engine-store`](reference/engine-store.md)
- [`@flows/sync`](reference/sync.md)
- [`@flows/time-travel`](reference/time-travel.md)
- [`@flows/host-cloudflare`](reference/host-cloudflare.md)
- [`@flows/host-vercel`](reference/host-vercel.md)

## Architecture

- [Package map](architecture/package-map.md)
- [Execution and data flow](architecture/execution-data-flow.md)
- [Design decisions](architecture/design-decisions.md)
- [Implementation status](architecture/implementation-status.md)

## Documentation conventions

“Implemented” means the behavior exists in `packages/*/src` and is exercised by the repository’s package tests. “Planned” means the source contains only a contract, test double, TODO, or no API at all. Examples use the repository’s current `effect@4.0.0-beta.102` APIs and the public `@flows/*` package exports.
