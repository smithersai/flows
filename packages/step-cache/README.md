# @smthrs/step-cache-next

The flows step result cache: which sealed action results may be reused.
Split out of `@smthrs/journal-next` — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

`CacheStore` is a keyed memoization of sealed step results, addressed by the
step key digest of [Step Keys](../../../docs/specs/Concepts/Step%20Keys.md). It is
deliberately called a _cache_: entries may be evicted, a stale entry is a miss
rather than a corruption, and admission is gated the same way for normal
execution, replay, and speculation validation alike.

It shares nothing with the journal or the run store beyond the database
underneath, which is why it is its own package and depends only on
`@smthrs/database-next`.

```sh
npm install @smthrs/step-cache-next
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/step-cache-next/*` subpaths.

| Namespace    | Public exports                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheStore` | `CacheStoreErrorCode`, `CacheStoreError`, `CacheEntry`, and `PutResult`; `Service` / `CacheStore` operations `get`, `put`, and `evict`; `make`, `makeNoop`, `layerNoop`, and SQL `layer`. |
| `Migrations` | `set` (the namespaced migration set for `flows_step_cache`), `run`, and prerequisite `layer`.                                                                                             |

The root is written against the driver-neutral `@smthrs/database-next` contract and
bundles for the browser. The test double binds a Node SQLite database, so it
lives under an explicit subpath:

| Import                                        | Public exports                                                |
| --------------------------------------------- | ------------------------------------------------------------- |
| `@smthrs/step-cache-next/test/TestCacheStore` | **Node only.** `layer`, providing a migrated in-memory cache. |

An engine needs this package, `@smthrs/journal-next`, and `@smthrs/run-store-next` over
one database; `@smthrs/engine-store-next/Migrations` composes all four migration
sets, and `@smthrs/engine-store-next/test/TestStores` is the in-memory bundle.

```ts
import * as NodeDatabase from "@smthrs/database-next/node/NodeDatabase"
import { CacheStore, Migrations } from "@smthrs/step-cache-next"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const cache = CacheStore.layer.pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const store = yield* CacheStore.CacheStore
  return yield* store.get("digest")
}).pipe(Effect.provide(cache))
```

See the [step keys concept](../../../docs/specs/Concepts/Step%20Keys.md).
