# Testing

This guide covers deterministic host fixtures, an in-memory workflow engine, and SQL-backed engine integration tests. It does not require external services.

## Unit-test a handler

Use `WorkflowEngine.layerMemory` when the behavior under test does not require restart replay:

```ts
const layer = Build.toLayer(({ target }) =>
  Effect.succeed({ artifact: `${target}.js` })
).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory)
)

const result = await Effect.runPromise(
  Build.execute(
    { target: "server", sourceDigest: "abc" },
    { executionId: "test-build-1" }
  ).pipe(Effect.provide(layer))
)
```

Select explicit execution IDs so failures are reproducible.

## Test host operations

`TestHost.layer` supplies an in-memory filesystem, stub shell, seeded Random, HTTP transport, PTY, and Jujutsu service. Configure only the seams a test exercises:

```ts
import { TestHost } from "@flows/host"

const HostLayer = TestHost.layer({
  files: { "/workspace/input.txt": "hello" },
  commands: {
    "read-input": { stdout: "hello\n", exitCode: 0 }
  },
  seed: 42
})
```

Consult the actual `TestHost.layer` option types when extending a fixture; filesystem and shell helpers deliberately implement only the host contracts used by tests.

For kernel tests, `TestGrantStore.layerAllow`, `layerDeny`, and `layerScripted` provide explicit authorization behavior.

## Test durable persistence

Combine:

- `TestJournal.layer()` for migrated in-memory SQLite stores,
- `DurableEngineState.makeMemory()` for deferred/clock state,
- `StepBoundary.layerTest()` for deterministic boundary evidence,
- a stub `Jj`.

Create a second `EngineStore.make` within the same service scope to simulate engine restart. Register the same handler, complete a deferred or call `resume`, and assert that completed activity code was not dispatched twice.

Flush the journal before reading committed entries:

```ts
const journal = yield* Journal.Journal
yield* journal.flush
const page = yield* journal.entries({ runId, limit: 100 })
```

An accepted submission is not necessarily durable until `flush` completes.

## Test invariants

High-value properties include:

- canonical inputs produce the same `StepKey`,
- reordered object keys and set-like declarations do not change a content key,
- replay reuses completed attempt exits,
- irreversible retries without idempotency fail,
- stale ownership cannot be stolen without liveness evidence,
- rejected journal admission does not imply contiguous sequence numbers,
- sync resumes from the last applied cursor,
- rewind preserves an audit on injected failure.

Run all package checks with:

```sh
npm run check
```

See [Determinism and replay](../concepts/determinism-and-replay.md) and the package references for [`@flows/host`](../reference/host.md) and [`@flows/journal`](../reference/journal.md).
