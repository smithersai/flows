# `@smthrs/step-cache`

This page is the public API reference for the **step result cache**: sealed
activity results addressed by step-key digest. It was split out of
`@smthrs/journal` — see
[`docs/specs/Concepts/Journal Split.md`](../specs/Concepts/Journal%20Split.md).

It is deliberately a *cache*. Entries may be evicted, a stale entry is a miss
rather than a corruption, and the same admission gate serves normal execution,
replay, and speculation validation alike. The package depends on
`@smthrs/database` and nothing else.

## CacheStore

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance. `evict(keyDigest, { ifRecordedBy })` deletes only while the row still carries that `(runId, eventSeq)` pair — both halves, since sequence numbers are per-run and collide across runs routinely. Whether the insert conflicted and whether the fenced delete hit are read through [`DurableWriter.affectedRows`](database.md#durablewriter) rather than a driver-specific `changes` cast, so the outcomes hold on every backend (issue #134).

`CacheStore` exports SQL `make`/`layer` plus a no-op test seam.

A cache hit *is* the step's result, so cached rows are never redacted: a
name-suffix redactor there would hand the flow a `"[REDACTED]"` string where it
expected its own value (issue #72). `CacheStore.layer` round-trips `result` and
`meta` byte-for-byte.

## Entry points

The root is written against the driver-neutral `@smthrs/database` service and
bundles for the browser (`npm run browser`). The test double binds a Node
SQLite database and is therefore imported from
`@smthrs/step-cache/test/TestCacheStore`. See
[browser support](../architecture/browser-support.md).

## Migrations

`Migrations.set` is this package's namespaced migration set —
`flows_step_cache` — and reserves migration id block `2000`. `Migrations.run` /
`Migrations.layer` install it alone; `@smthrs/engine-store/Migrations` composes
it with the journal's, the run store's, and the engine's. See
[`@smthrs/database`](database.md) for the composition rules.

See [Step keys](../specs/Concepts/Step%20Keys.md) and the
[`@smthrs/engine-store` reference](engine-store.md).
