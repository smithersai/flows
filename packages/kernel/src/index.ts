/**
 * @since 0.1.0
 *
 * `@smthrs/kernel` — capability enforcement at the Host boundary.
 */

/**
 * Capability values, patterns, matching, and effect tiers.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Capability from "./Capability.ts"

/**
 * Monotone ambient authority and intersection.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as CapabilitySet from "./CapabilitySet.ts"

/**
 * Permission-decorated process spawning.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as ChildProcessSpawner from "./ChildProcessSpawner.ts"

/**
 * Rendering `ChildProcess` commands back to command lines.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as CommandLine from "./CommandLine.ts"

/**
 * Permission-decorated filesystem services.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as FileSystem from "./FileSystem.ts"

/**
 * Durable grant decision schemas.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as GrantEvent from "./GrantEvent.ts"

/**
 * Attended and unattended grant-store services.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as GrantStore from "./GrantStore.ts"

/**
 * The union of failures the closed Host surface is allowed to produce.
 *
 * A type, not a namespace: process execution now fails with Effect's own
 * `PlatformError`, so nothing is left here to construct.
 *
 * @category models
 * @since 0.1.0
 */
export type { HostError } from "./HostError.ts"

/**
 * The closed protected Host service layer.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as HostServices from "./HostServices.ts"

/**
 * Permission-decorated single-hop HTTP.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as HttpClient from "./HttpClient.ts"

/**
 * Permission-decorated Jujutsu services.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Jj from "./Jj.ts"

/**
 * Journal-backed grant persistence.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as JournalGrantStore from "./JournalGrantStore.ts"

/**
 * The explicit pure path-service decision.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Path from "./Path.ts"

/**
 * Typed permission errors and policy rules.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Permission from "./Permission.ts"

/**
 * The shared workspace-root service.
 *
 * @category namespace exports
 * @since 0.1.0
 */
export * as Workspace from "./Workspace.ts"
