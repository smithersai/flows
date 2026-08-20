/**
 * Step cache schema migrations.
 *
 * This package owns `flows_step_cache` and `flows_step_cache_recorded` and
 * reserves migration id block `2000`, so its ids can never collide with the
 * journal's or the run store's — see `@smthrs/database`'s `Migrations` for how
 * the blocks compose.
 *
 * The fold demoted both tables to rebuildable materializations of
 * `flows.cache.*` journal events, so {@link set} alone is not enough: the
 * `0002_journal_fold` backfill and the SQL `CacheStore.layer` both append to
 * `@smthrs/journal`'s tables, and the journal's migration set must be
 * installed first. {@link run} and {@link layer} compose the prerequisite;
 * a caller composing sets by hand lists `JournalMigrations.set` before this
 * one, as `@smthrs/engine-store/Migrations` does.
 *
 * Derived contracts: `docs/specs/Concepts/Step Keys.md` and
 * `docs/specs/Concepts/Step Cache Fold.md`.
 *
 * @since 0.1.0
 */
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as Layer from "effect/Layer"
import initial from "./migrations/0001_initial.ts"
import journalFold from "./migrations/0002_journal_fold.ts"

/**
 * The step cache's namespaced migration set, for composition with the other
 * storage packages. Compose it after `@smthrs/journal`'s set.
 *
 * @category migrations
 * @since 0.1.0
 */
export const set: DatabaseMigrations.MigrationSet = {
  namespace: "step-cache",
  idOffset: DatabaseMigrations.idBlock * 2,
  migrations: {
    "0001_initial": initial,
    "0002_journal_fold": journalFold
  }
}

/**
 * Creates the step cache schema and the journal prerequisite it appends to.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = DatabaseMigrations.run([JournalMigrations.set, set])

/**
 * Layer that runs the journal and step-cache migrations before exposing the
 * database to the cache service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
