/**
 * Bun layer for Effect's `FileSystem` service.
 *
 * This mirrors `@effect/platform-bun/BunFileSystem`: Bun uses Effect's shared
 * Node-compatible filesystem implementation while consumers depend only on the
 * standard `FileSystem` contract.
 *
 * @since 0.1.0
 */
import type * as PlatformBunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import type { FileSystem } from "effect/FileSystem"
import type * as Layer from "effect/Layer"

const compatibleLayer: typeof PlatformBunFileSystem.layer = NodeFileSystem.layer

/**
 * Provides Bun's filesystem implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<FileSystem> = compatibleLayer
