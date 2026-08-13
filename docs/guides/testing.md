# Testing

This guide covers deterministic host fixtures, an in-memory flow engine, and SQL-backed engine integration tests. It does not require external services.

## Unit-test a handler

Use `FlowEngine.layerMemory` when the behavior under test does not require restart replay:

```ts
const layer = Build.toLayer(({ target }) =>
  Effect.succeed({ artifact: `${target}.js` })
).pipe(
  Layer.provideMerge(FlowEngine.layerMemory)
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

`TestHost.layer` supplies an in-memory filesystem, a scripted command interpreter, seeded Random, a Jujutsu service, and Effect's `HttpClient` tag filled by `HttpClient.layerNoop()` — a stub that fails every request with a `TransportError`, so a test that needs real responses provides its own client over the bundle. Configure only the seams a test exercises:

```ts
import * as TestHost from "@smthrs/kernel-next/test/TestHost"

const HostLayer = TestHost.layer({
  files: { "/workspace/input.txt": "hello" },
  commands: {
    "read-input": { stdout: "hello\n", exitCode: 0 }
  },
  seed: 42
})
```

`TestHost` is imported from its subpath rather than the `@smthrs/kernel-next` root, which stays browser-safe ([browser support](../architecture/browser-support.md)); `effect/testing`'s `TestClock` reaches for `node:assert`, so the bundle itself is Node-only. Consult the actual `TestHost.layer` option types when extending a fixture; the filesystem and interpreter helpers deliberately implement only the host contracts used by tests.

For kernel tests, `TestGrantStore.layerAllow`, `layerDeny`, and `layerScripted` provide explicit authorization behavior.

## Test durable persistence

Combine:

- `TestJournal.layer()` (from `@smthrs/journal-next/test/TestJournal`) for a migrated in-memory SQLite journal, `TestRunStore.layer` and `TestCacheStore.layer` for the run and cache stores, or `TestStores.layer()` (from `@smthrs/engine-store-next/test/TestStores`) for all four over one database,
- `DurableEngineState.makeMemory()` for deferred/clock state,
- `StepBoundary.layerTest()` for deterministic boundary evidence,
- a stub `Jj` (`@smthrs/jj-next/browser/BrowserJj`'s `layerUnsupported`).

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

- canonical inputs produce the same `Key`,
- reordered object keys and set-like declarations do not change a cache key,
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

See [Determinism and replay](../concepts/determinism-and-replay.md) and the package references for [`@smthrs/kernel-next`](../reference/kernel.md), [`@smthrs/journal-next`](../reference/journal.md), [`@smthrs/run-store-next`](../reference/run-store.md), and [`@smthrs/step-cache-next`](../reference/step-cache.md).
