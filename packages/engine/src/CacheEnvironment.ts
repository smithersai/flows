import * as Schema from "effect/Schema"

/**
 * Validates named capability groups.
 *
 * @private
 * @since 0.1.0
 */
const Capabilities = Schema.Record(Schema.String, Schema.Array(Schema.NonEmptyString)).check(
  Schema.makeFilter((capabilities) =>
    Object.keys(capabilities).every((name) => name.length > 0) || "Capability names must not be empty"
  )
)

/**
 * Complete runtime environment included in every cross-run cache key.
 *
 * If a composition cannot provide this complete value, the engine executes
 * normally but does not derive a cross-run cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheEnvironment = typeof CacheEnvironment.Type

/**
 * Schema for the complete runtime environment included in cache keys.
 *
 * @category models
 * @since 0.1.0
 */
export const CacheEnvironment = Schema.Struct({
  /** Ordered semantic runtime layers, including versions and configuration. */
  layers: Schema.Array(Schema.NonEmptyString),
  /** Complete effective capability groups. */
  capabilities: Capabilities
})
