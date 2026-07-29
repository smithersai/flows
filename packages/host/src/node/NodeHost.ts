/**
 * Aggregate Node.js host services layer.
 *
 * This module defines the `NodeHost` service union and a single `layer` that
 * provides the Node-backed shell, pty, and jj implementations. Use the layer
 * when a Node program wants every host capability from one place; use the
 * individual modules (re-exported below) when a program should only be able to
 * reach part of the host.
 *
 * @since 1.0.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { HttpTransport } from "../HttpTransport.ts"
import type { Jj } from "../Jj.ts"
import type { Pty } from "../Pty.ts"
import type { Shell } from "../Shell.ts"
import * as NodeHttpTransport from "./NodeHttpTransport.ts"
import * as NodeJj from "./NodeJj.ts"
import * as NodePty from "./NodePty.ts"
import * as NodeShell from "./NodeShell.ts"

export { NodeHttpTransport, NodeJj, NodePty, NodeShell }

/**
 * The union of host services provided by the Node host layer.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeHost = FileSystem | Path.Path | Jj | Pty | Shell | HttpTransport

/**
 * Provides the default Node implementations for the shell, pty, and jj host
 * services.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<NodeHost> = Layer.mergeAll(
  NodeFileSystem.layer,
  Path.layer,
  NodeHttpTransport.layer,
  NodeShell.layer,
  NodePty.layer,
  NodeJj.layer
)
