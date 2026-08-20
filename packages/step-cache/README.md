# @smthrs/step-cache

The flows step result cache: which sealed action results may be reused.
Split out of `@smthrs/journal` — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

`CacheStore` is a keyed memoization of sealed step results, addressed by the
step key digest of [Step Keys](../../../docs/specs/Concepts/Step%20Keys.md). It is
deliberately called a _cache_: entries may be evicted, a stale entry is a miss
rather than a corruption, and admission is gated the same way for normal
execution, replay, and speculation validation alike.

```sh
pnpm add @smthrs/step-cache
```

## The durable contract is the journal

The two tables this package owns — the `flows_step_cache` head and the
append-only `flows_step_cache_recorded` provenance ledger — are rebuildable
materializations of journal events, not independent durable stores. Dropping
them and replaying the journal rebuilds equivalent state; the tables exist for
fast lookup. The design is the step-cache row of
[`docs/specs/Concepts/Journal Consensus.md`](../../../docs/specs/Concepts/Journal%20Consensus.md),
filled in by
[`docs/specs/Concepts/Step Cache Fold.md`](../../../docs/specs/Concepts/Step%20Cache%20Fold.md).

The SQL layer appends an event in the reserved `flows.cache.*` namespace in
the same `DurableWriter` transaction as every row change, so either the row
and its event are both durable or neither is:

- `flows.cache.recorded` — appended by `put` when and only when a table
  changed: an `Inserted` head row, or a `Conflict` / new-provenance
  `ExistingSame` that landed a ledger row. The payload is the full entry
  (`keyDigest`, `result`, `meta`, `createdAtMs`, `recordedRunId`,
  `recordedEventSeq`), so replay is deterministic and provenance survives
  byte-for-byte. A repeat that changes nothing appends nothing — that is the
  fold's idempotency. An identical re-record after an eviction journals at
  the producer identity's next `sourceSeq` rather than collapsing into a
  duplicate of the original append.
- `flows.cache.evicted` — appended by `evict` when a row was actually
  deleted, carrying the deleted row's provenance. A fenced compare-and-swap
  that matched no row appends nothing.
- `flows.cache.snapshot` — administrative. The fold migration backfills one
  per pre-fold row so existing entries are never orphaned from history, and
  journal compaction uses snapshots as the fold's checkpoint.

Cache events are unfenced: admission is content-address first-writer-wins,
not run ownership, and `put`/`evict` carry no owner. Each event appends under
the entry's `recordedRunId` with that run's root lineage in `meta`, and
bypasses the journal's write-path redactor because cached results are
executable state served verbatim on a hit. First-writer-wins admission, the
canonical-JSON `ExistingSame`/`Conflict` decision, payload discipline
(oversized outputs stay digest-referenced, never inlined), and step-key
staleness semantics are unchanged from the pre-fold store.

Eviction of durable history is a journal concern, not a cache-side mechanism:
dropping a materialized row is always safe because the retained journal
rebuilds it, and permanent space reclamation happens through journal
checkpoint/compaction. Nothing but compaction deletes a ledger row; the fold
itself never does.

This package therefore depends on `@smthrs/database` for the driver-neutral
SQL contract and on `@smthrs/journal` for the events behind its tables.

## Public API

The root exports these namespaces, also available from matching
`@smthrs/step-cache/*` subpaths.

| Namespace    | Public exports                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheStore` | `CacheStoreErrorCode`, `CacheStoreError`, `CacheEntry`, and `PutResult`; `Service` / `CacheStore` operations `get`, `put`, and `evict`; `make`, `makeNoop`, `layerNoop`, and SQL `layer`.                                                                            |
| `Fold`       | The head and ledger reducers as journal `Projection`s, and `rebuild`, which truncates and repopulates both tables from the journal inside one `DurableWriter` transaction. Rebuild, recovery, and time travel recompute the tables this way; forward writes never do. |
| `Migrations` | `set` (the namespaced migration set for `flows_step_cache` and `flows_step_cache_recorded`), `run`, and prerequisite `layer`. This set alone is not enough for the SQL layer: the fold appends to `@smthrs/journal`'s tables, so `CacheStore.layer` requires the journal's migration set to be installed too — compose the two sets, as the example below and `@smthrs/engine-store/Migrations` do. |

The root is written against the driver-neutral `@smthrs/database` contract and
bundles for the browser. The test double binds a Node SQLite database, so it
lives under an explicit subpath:

| Import                                   | Public exports                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@smthrs/step-cache/test/TestCacheStore` | **Node only.** `layer`, providing a migrated in-memory cache together with the journal it appends to. |

An engine needs this package, `@smthrs/journal`, and `@smthrs/run-store` over
one database; `@smthrs/engine-store/Migrations` composes all four migration
sets, and `@smthrs/engine-store/test/TestStores` is the in-memory bundle.

```ts
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import { SqlJournal } from "@smthrs/journal"
import { CacheStore, Migrations } from "@smthrs/step-cache"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const migrations = Layer.effectDiscard(
  DatabaseMigrations.run([JournalMigrations.set, Migrations.set])
)
const journal = SqlJournal.layer({ capacity: 1024, overflow: "reject" })
const cache = CacheStore.layer.pipe(
  Layer.provide(journal),
  Layer.provide(Layer.provideMerge(migrations, database))
)

const program = Effect.gen(function*() {
  const store = yield* CacheStore.CacheStore
  return yield* store.get("digest")
}).pipe(Effect.provide(cache))
```

See the [step keys concept](../../../docs/specs/Concepts/Step%20Keys.md) and the
[step cache fold design](../../../docs/specs/Concepts/Step%20Cache%20Fold.md).
