/**
 * In-memory SQLite database layer for tests.
 *
 * @since 0.1.0
 */
import * as NodeDatabase from "../node/NodeDatabase.ts"

/**
 * Provides the production Node SQLite path over a fresh in-memory database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = NodeDatabase.layer({ filename: ":memory:" })
