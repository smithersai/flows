/**
 * Bun `Pty` implementation.
 *
 * Bun supports the Node child-process APIs used by the shared cursor/replay
 * implementation, so the bounded replay ring and scoped kill finalizer are
 * reused without a second implementation.
 *
 * @since 0.1.0
 */
import type * as Layer from "effect/Layer"
import * as NodePty from "../node/NodePty.ts"
import type { Pty } from "../Pty.ts"

/**
 * Provides Bun's scoped pseudo-terminal compatibility implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Pty> = NodePty.layer
