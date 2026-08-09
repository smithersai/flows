/**
 * Durable journal, ownership, attempt, and cache services.
 *
 * This entry point is browser-bundleable: every store here is written against
 * the driver-neutral `@smthrs/database` contract. The test doubles, which
 * bind a Node SQLite database, live under explicit subpaths:
 *
 * ```ts
 * import { Journal, SqlJournal } from "@smthrs/journal"
 * import * as TestJournal from "@smthrs/journal/test/TestJournal"
 * import * as Notifying from "@smthrs/journal/test/Notifying"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category events
 * @since 0.1.0
 */
export * as JournalEvent from "./JournalEvent.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as Journal from "./Journal.ts"

/**
 * @category layers
 * @since 0.1.0
 */
export * as SqlJournal from "./SqlJournal.ts"

/**
 * @category redaction
 * @since 0.1.0
 */
export * as Redaction from "./Redaction.ts"

/**
 * @category projections
 * @since 0.1.0
 */
export * as Projection from "./Projection.ts"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as RunStore from "./RunStore.ts"

/**
 * @category ownership
 * @since 0.1.0
 */
export * as Ownership from "./Ownership.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as AttemptStore from "./AttemptStore.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as CacheStore from "./CacheStore.ts"

/**
 * @category coordination
 * @since 0.1.0
 */
export * as RunCoordinator from "./RunCoordinator.ts"
