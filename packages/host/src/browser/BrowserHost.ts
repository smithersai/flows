import { Effect, Layer, Path } from "effect"
import type { FileSystem } from "effect"
import { JjError, PtyError } from "../HostError.ts"
import type { HttpTransport } from "../HttpTransport.ts"
import { Jj } from "../Jj.ts"
import { Pty } from "../Pty.ts"
import type { Shell } from "../Shell.ts"
import * as BrowserFileSystem from "./BrowserFileSystem.ts"
import * as BrowserHttpTransport from "./BrowserHttpTransport.ts"
import * as JustBashShell from "./JustBashShell.ts"

/**
 * There is no pseudo-terminal in a browser tab: no `openpty`, no child process
 * to attach one to. The service is still present and still fails in the error
 * channel, so a caller sees a typed `PtyError` rather than a missing tag.
 *
 * TICKET: pty-in-browser — see Tickets Not Exceptions
 */
export const layerPtyUnsupported: Layer.Layer<Pty> = Layer.succeed(Pty)({
  spawn: (cmd) =>
    Effect.fail(
      new PtyError({
        code: "unsupported",
        message: `no pty in the browser (requested: ${cmd})`
      })
    )
})

/**
 * jj is a native binary. Until it is compiled to wasm there is nothing to run,
 * so every operation reports `not_installed` — the same code the node
 * implementation uses when the binary is absent, which keeps callers from
 * needing a browser-specific branch.
 *
 * TICKET: browser jj (wasm) — see Concepts/Browser jj.md
 */
export const layerJjUnsupported: Layer.Layer<Jj> = Layer.succeed(Jj)(
  (() => {
    const fail = (command: string) =>
      Effect.fail(
        new JjError({
          code: "not_installed",
          message: "jj is not available in the browser",
          command
        })
      )
    return {
      snapshot: () => fail("jj commit"),
      restore: () => fail("jj edit"),
      diff: () => fail("jj diff"),
      workspaceAdd: () => fail("jj workspace add"),
      workspaceForget: () => fail("jj workspace forget"),
      status: () => fail("jj status")
    }
  })()
)

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
    layerPtyUnsupported,
    layerJjUnsupported
  )
