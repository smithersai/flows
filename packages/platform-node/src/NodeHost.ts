/**
 * Aggregate Node.js Host bundle.
 *
 * This module defines the `NodeHost` service union and a single `layer` that
 * provides the closed Host surface backed by Node: `@effect/platform-node`'s
 * filesystem and child-process spawner, Effect's `Path`, the Undici transport,
 * and the Node `Pty` and `Jj` adapters from their own packages. Use the layer
 * when a Node program wants every host capability from one place; use the
 * individual modules when a program should only be able to reach part of the
 * host.
 *
 * There is no Node shell module: running a command is Effect's
 * `ChildProcessSpawner`, and `@effect/platform-node` already ships the
 * implementation.
 *
 * @since 0.1.0
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import type { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import type { HttpTransport } from "@smthrs/kernel/HttpTransport"
import type { Pty } from "@smthrs/pty"
import * as NodePty from "@smthrs/pty/node/NodePty"
import type { FileSystem } from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeHttpTransport from "./NodeHttpTransport.ts"

/**
 * Node platform modules owned by this package, plus the two Effect ships.
 * `NodeJj` and `NodePty` belong to `@smthrs/jj` and `@smthrs/pty`; import them
 * from there.
 *
 * @category re-exports
 * @since 0.1.0
 */
export { NodeChildProcessSpawner, NodeFileSystem, NodeHttpTransport }

/**
 * The union of host services provided by the Node host layer.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeHost = FileSystem | Path.Path | ChildProcessSpawner | Pty | Jj | HttpTransport

/** The two services `NodeChildProcessSpawner` resolves paths and files with. */
const platform = Layer.mergeAll(NodeFileSystem.layer, Path.layer)

/**
 * Provides the default Node implementations for the whole closed Host surface.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<NodeHost> = Layer.mergeAll(
  platform,
  Layer.provide(NodeChildProcessSpawner.layer, platform),
  NodeHttpTransport.layer,
  NodePty.layer,
  NodeJj.layer
)
