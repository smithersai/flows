# @smthrs/step-cache

Sealed step results addressed by step-key digest. Split out of [`@smthrs/journal`](/api/journal); it depends on `@smthrs/database` and nothing else, so the package root bundles for the browser.

```ts
import { CacheStore, Migrations } from "@smthrs/step-cache"
import * as Layer from "effect/Layer"

const layer = CacheStore.layer.pipe(Layer.provideMerge(Migrations.layer))
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/step-cache` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/index.ts) | any |
| `@smthrs/step-cache/test/TestCacheStore` | [src/test/TestCacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/test/TestCacheStore.ts) | Node |

## CacheStore

[src/CacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/CacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `CacheStore` | service tag | digest to result, first writer wins |
| `CacheEntry` | interface | `resultJson`, `metaJson`, `createdAtMs`, `recordedRunId`, `recordedEventSeq` |
| `PutResult` | type | `Inserted`, `ExistingSame`, `Conflict` |
| `EvictOptions` | type | eviction arguments |
| `CacheStoreError`, `CacheStoreErrorCode` | class + codes | |
| `make`, `makeNoop` | constructors | |
| `layer`, `layerNoop` | layers | |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_step_cache`, in id block `2000` |
| `run` | effect | apply the cache schema |
| `layer` | layer | applies it at construction |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestCacheStore.layer` | [src/test/TestCacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/test/TestCacheStore.ts) | a migrated step cache over in-memory SQLite |
