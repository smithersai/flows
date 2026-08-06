/**
 * Deterministic bundle of the production journal services.
 *
 * Governing designs: `docs/specs/Concepts/Journal Queue.md` and
 * `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smithers/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as AttemptStore from "../AttemptStore.ts"
import * as CacheStore from "../CacheStore.ts"
import * as Migrations from "../Migrations.ts"
import * as RunStore from "../RunStore.ts"
import * as SqlJournal from "../SqlJournal.ts"

/**
 * Options for the deterministic journal bundle.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestJournalOptions {
  readonly capacity?: number
  readonly overflow?: "reject" | "drop-newest" | "drop-oldest"
  readonly batchSize?: number
}

/**
 * Provides the production SQLite journal, run, attempt, and cache services over
 * an in-memory database. Migrations run before any durable service is exposed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: TestJournalOptions) => {
  const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
  return Layer.mergeAll(
    SqlJournal.layer({
      capacity: options?.capacity ?? 1024,
      overflow: options?.overflow ?? "reject",
      batchSize: options?.batchSize
    }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer
  ).pipe(Layer.provide(database))
}
