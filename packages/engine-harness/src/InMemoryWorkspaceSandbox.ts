/**
 * Deterministic in-memory implementation of the canonical engine-store
 * workspace sandbox.
 *
 * @since 0.1.0
 */
import * as WorkspaceSandbox from "@smthrs/engine-store-next/WorkspaceSandbox"

/** @category models @since 0.1.0 */
export type InitialFiles = WorkspaceSandbox.InitialFiles

/** @category models @since 0.1.0 */
export type HostFile = WorkspaceSandbox.HostFile

/** @category models @since 0.1.0 */
export type InMemoryWorkspaceSandbox = WorkspaceSandbox.MemorySandbox

/**
 * Creates the engine-store conformance sandbox over an in-memory host.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = WorkspaceSandbox.makeMemory
