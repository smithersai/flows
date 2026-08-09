/**
 * @smthrs/database public API.
 *
 * This entry point is the driver-neutral SQL contract, so it stays
 * browser-bundleable. The drivers themselves are Node-only — `node:sqlite`
 * through `@effect/sql-sqlite-node` — and live under explicit subpaths, the
 * way `effect` keeps platform packages out of its own root:
 *
 * ```ts
 * import { Database } from "@smthrs/database"
 * import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
 * import * as TestDatabase from "@smthrs/database/test/TestDatabase"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 */
export * as Database from "./Database.ts"
