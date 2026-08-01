/**
 * The contract's other half: a bundle that provides every tag in the closed
 * Host list and supports none of them.
 *
 * `NodeHost`, `BunHost`, `BrowserHost`, and `TestHost` between them declare
 * almost everything as supported, so the suite's "declared unsupported" arm —
 * and the three error shapes `errorCode` has to normalize — would otherwise go
 * unasserted. A serverless or locked-down bundle looks exactly like this.
 */
import { Effect, Layer, Path } from "effect"
import * as BrowserFileSystem from "../../src/browser/BrowserFileSystem.ts"
import { layerJjUnsupported, layerPtyUnsupported } from "../../src/browser/BrowserHost.ts"
import * as HttpTransport from "../../src/HttpTransport.ts"
import * as ShellService from "../../src/Shell.ts"
import { runHostContract } from "./HostContract.ts"

const rejecting = (): BrowserFileSystem.ZenFsPromisesLike => {
  const denied = () => Promise.reject(new Error("filesystem is unavailable on this host"))
  return {
    open: denied,
    readFile: denied,
    writeFile: denied,
    mkdir: denied,
    readdir: denied,
    stat: denied,
    rm: denied
  }
}

const basePath = Effect.runSync(Effect.provide(Path.Path, Path.layer))

/** A `Path` that has no file URL scheme to resolve, the way a VFS host does. */
const layerPathUnsupported: Layer.Layer<Path.Path> = Layer.succeed(Path.Path)({
  ...basePath,
  fromFileUrl: () => {
    throw { _tag: "NoFileUrls" }
  }
})

runHostContract(
  "UnsupportedHost",
  Layer.mergeAll(
    BrowserFileSystem.layer(rejecting()),
    layerPathUnsupported,
    ShellService.layerNoop({}),
    layerPtyUnsupported,
    layerJjUnsupported,
    HttpTransport.layerNoop()
  ),
  {
    // A `PlatformError` carries its code as `reason._tag`.
    fileSystem: { expected: "failure", code: "Unknown" },
    // A thrown tagged value carries it as a bare `_tag`.
    path: { expected: "failure", code: "NoFileUrls" },
    // Host errors carry it as `code`.
    shell: { expected: "failure", code: "shell_unavailable" },
    pty: { expected: "failure", code: "unsupported" },
    jj: { expected: "failure", code: "not_installed" },
    httpTransport: { expected: "failure", code: "TransportError" }
  }
)
