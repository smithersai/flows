/**
 * Aggregate Node.js host services layer.
 *
 * This module defines the `NodeHost` service union and a single `layer` that
 * provides the Node-backed shell, pty, and jj implementations. Use the layer
 * when a Node program wants every host capability from one place; use the
 * individual modules when a program should only be able to reach part of the
 * host.
 *
 * @since 1.0.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import type { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import type { Pty } from "@smthrs/pty"
import * as NodePty from "@smthrs/pty/node/NodePty"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { HttpTransport } from "../HttpTransport.ts"
import type { Shell } from "../Shell.ts"
import * as NodeHttpTransport from "./NodeHttpTransport.ts"
import * as NodeShell from "./NodeShell.ts"

/**
 * Node platform modules owned by this package. `NodeJj` and `NodePty` belong
 * to `@smthrs/jj` and `@smthrs/pty`; import them from there.
 */
export { NodeHttpTransport, NodeShell }

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
