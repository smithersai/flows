/**
 * Deterministic bundle of the production step cache service.
 *
 * The cache is a fold of journal events, so the bundle provides the journal
 * it appends to alongside the store, over one migrated in-memory database.
 *
 * Governing designs: `docs/specs/Concepts/Step Keys.md` and
 * `docs/specs/Concepts/Step Cache Fold.md`.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as Layer from "effect/Layer"
import * as CacheStore from "../CacheStore.ts"
import * as Migrations from "../Migrations.ts"

const journal = SqlJournal.layer({ capacity: 1024, overflow: "reject" })

/**
 * Provides the production SQLite step cache and the journal its fold appends
 * to, over one in-memory database. Migrations — the journal's set and this
 * package's — run before either service is exposed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.mergeAll(
  journal,
  CacheStore.layer.pipe(Layer.provide(journal))
).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)
