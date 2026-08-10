import * as Schema from "effect/Schema"

/**
 * Schema for how strictly a filesystem boundary is enforced.
 *
 * `hard` rejects undeclared access. `expected` records access for later
 * validation without requiring the sandbox to reject it immediately.
 *
 * @category models
 * @since 0.1.0
 */
export const BoundaryMode = Schema.Literals(["hard", "expected"])

/**
 * How strictly a filesystem boundary is enforced.
 *
 * @category models
 * @since 0.1.0
 */
export type BoundaryMode = typeof BoundaryMode.Type
