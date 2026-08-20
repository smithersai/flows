/**
 * The step result cache: which sealed results may be reused.
 *
 * `CacheStore` is a keyed memoization of sealed action results whose entries
 * may be evicted — a cache, in the `docs/specs/Concepts/Step Keys.md` sense.
 * Its tables are rebuildable materializations of `flows.cache.*` journal
 * events: the SQL layer appends the event describing every row change in the
 * same transaction, and `Fold` rebuilds the tables from the retained journal.
 * See `docs/specs/Concepts/Step Cache Fold.md`.
 *
 * This entry point is browser-bundleable: the service is written against the
 * driver-neutral `@smthrs/database` contract and the browser-safe core of
 * `@smthrs/journal`. The test double, which binds a Node SQLite database,
 * lives under an explicit subpath:
 *
 * ```ts
 * import { CacheStore } from "@smthrs/step-cache"
 * import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 */
export * as CacheStore from "./CacheStore.ts"

/**
 * @category metrics
 * @since 0.1.0
 */
export * as CacheStoreMetrics from "./CacheStoreMetrics.ts"

/**
 * @category projections
 * @since 0.1.0
 */
export * as Fold from "./Fold.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as CombinedCacheStore from "./CombinedCacheStore.ts"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as RemoteCacheStore from "./RemoteCacheStore.ts"
