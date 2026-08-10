/**
 * Aggregate browser host services layer.
 *
 * `Pty` and `Jj` have no browser implementation; their packages ship the
 * ticket-failing layers this bundle installs, so an absent capability is still
 * a capability with an answer rather than a missing tag.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smthrs/jj"
import * as BrowserJj from "@smthrs/jj/browser/BrowserJj"
import type { Pty } from "@smthrs/pty"
import * as BrowserPty from "@smthrs/pty/browser/BrowserPty"
import { Layer, Path } from "effect"
import type { FileSystem } from "effect"
import type { HttpTransport } from "../HttpTransport.ts"
import type { Shell } from "../Shell.ts"
import * as BrowserFileSystem from "./BrowserFileSystem.ts"
import * as BrowserHttpTransport from "./BrowserHttpTransport.ts"
import * as JustBashShell from "./JustBashShell.ts"

/**
 * The complete Host bundle for a browser tab.
 *
 * Both backends are passed in rather than imported: the page owns which ZenFS
 * backend is mounted and which just-bash instance is wired to it, and they must
 * be the *same* filesystem or the shell and the FileSystem service will disagree
 * about what exists.
 */
export const layer = (options: {
  readonly bash: JustBashShell.JustBashLike
  readonly fs: BrowserFileSystem.ZenFsPromisesLike
}): Layer.Layer<FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport> =>
  Layer.mergeAll(
    BrowserFileSystem.layer(options.fs),
    BrowserHttpTransport.layer,
    Path.layer,
    JustBashShell.layer(options.bash),
    BrowserPty.layerUnsupported,
    BrowserJj.layerUnsupported
  )
