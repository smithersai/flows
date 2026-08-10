/**
 * Aggregate browser Host bundle.
 *
 * `BrowserServices` covers the three services a platform package owes Effect —
 * `ChildProcessSpawner`, `FileSystem`, `Path`. This module is the layer above
 * it: the complete closed Host surface `flows` runs on, so the same six tags
 * `NodeHost` and `BunHost` provide are present in a tab too.
 *
 * `Pty` and `Jj` have no browser implementation; their packages ship the
 * ticket-failing layers this bundle installs, so an absent capability is still
 * a capability with an answer rather than a missing tag.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import type { HttpTransport } from "@smthrs/kernel/HttpTransport"
import type { Pty } from "@smthrs/pty"
import * as BrowserPty from "@smthrs/pty/browser/BrowserPty"
import { Layer, Path } from "effect"
import type { FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BrowserChildProcessSpawner from "./BrowserChildProcessSpawner.ts"
import * as BrowserFileSystem from "./BrowserFileSystem.ts"
import * as BrowserHttpTransport from "./BrowserHttpTransport.ts"

/**
 * The complete closed Host service union provided by a browser tab.
 *
 * @category models
 * @since 0.1.0
 */
export type BrowserHost =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | Pty
  | Jj
  | HttpTransport

/**
 * The complete Host bundle for a browser tab.
 *
 * Both backends are passed in rather than imported: the page owns which ZenFS
 * backend is mounted and which just-bash instance is wired to it, and they must
 * be the *same* filesystem or spawned commands and the FileSystem service will
 * disagree about what exists.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: {
  readonly bash: BrowserChildProcessSpawner.JustBashLike
  readonly fs: BrowserFileSystem.ZenFsPromisesLike
}): Layer.Layer<BrowserHost> => {
  const platform = Layer.mergeAll(BrowserFileSystem.layer(options.fs), Path.layer)
  return Layer.mergeAll(
    platform,
    Layer.provide(BrowserChildProcessSpawner.layer(options.bash), platform),
    BrowserHttpTransport.layer,
    BrowserPty.layerUnsupported,
    BrowserJj.layerUnsupported
  )
}
