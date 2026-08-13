/**
 * @smthrs/database-next public API.
 *
 * This entry point is the driver-neutral write boundary, so it stays
 * browser-bundleable. The drivers themselves are Node-only — `node:sqlite`
 * through `@effect/sql-sqlite-node` — and live under explicit subpaths, the
 * way `effect` keeps platform packages out of its own root:
 *
 * ```ts
 * import { DurableWriter } from "@smthrs/database-next"
 * import * as NodeDatabase from "@smthrs/database-next/node/NodeDatabase"
 * import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 */
export * as DurableWriter from "./DurableWriter.ts"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.ts"
