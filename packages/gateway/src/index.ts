/**
 * Workspace gateway contracts and supervision ports for flows.
 *
 * Governing design: `docs/specs/Concepts/Gateway.md`.
 *
 * @since 0.1.0
 */

/** @since 0.1.0 @category errors */
export * as GatewayError from "./GatewayError.ts"

/** @since 0.1.0 @category models */
export * as GatewaySchema from "./GatewaySchema.ts"

/** @since 0.1.0 @category services */
export * as SuperviseRuntime from "./SuperviseRuntime.ts"

/**
 * The canonical durable journal synchronization package.
 *
 * @since 0.1.0
 * @category services
 */
export * as Sync from "@smthrs/sync"
