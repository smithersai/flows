/**
 * The full Host contract over `BrowserHost.layer`, jj included: the committed
 * `flows_jj.wasm` artifact runs against a temp-directory-rooted sync
 * filesystem, exactly the shape a page supplies from a ZenFS mount. When the
 * artifact is absent the jj capability degrades to the instantiation failure
 * the layer actually reports — loudly, so a missing artifact is never mistaken
 * for a passing real-wasm contract.
 *
 * The contract exercises each service independently, so the memory fs behind
 * `FileSystem`/bash and the tmpdir behind jj may diverge here; a real page
 * must hand all three the same mount (see `BrowserHost.layer`'s doc).
 */
import { Jj } from "@smthrs/jj"
import type { SyncFsLike } from "@smthrs/jj/browser/WasiFs"
import { runHostContract } from "@smthrs/kernel/test/contract"
import * as TestHost from "@smthrs/kernel/test/TestHost"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll } from "vitest"
import type * as BrowserChildProcessSpawner from "../../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserHost from "../../src/BrowserHost.ts"

type BashResult = Awaited<ReturnType<BrowserChildProcessSpawner.JustBashLike["run"]>>

const result = (stdout: string): BashResult => ({ stdout, stderr: "", exitCode: 0 })

const bash: BrowserChildProcessSpawner.JustBashLike = {
  run: (command, options) => {
    if (command === "host-contract-exec") return Promise.resolve(result("browser-exec"))
    if (command === "host-contract-stream") return Promise.resolve(result("browser-stream"))
    if (command === "host-contract-options") {
      const valid = options?.cwd === "/" && options.env?.HOST_CONTRACT_ENV === "browser"
      return Promise.resolve(result(valid ? "browser-options" : "invalid-options"))
    }
    return Promise.resolve(result(""))
  }
}

// `node:fs` confined under a host directory, exposed as the `SyncFsLike` the
// wasm mounts as its namespace — the test-side stand-in for a ZenFS sync
// slice, mirroring packages/jj/test/RootedSyncFs.ts.
const rootedSyncFs = (hostRoot: string): SyncFsLike => {
  const at = (path: string): string => join(hostRoot, path)
  return {
    openSync: (path, flags, mode) => fsModule.openSync(at(path), flags, mode),
    closeSync: (fd) => fsModule.closeSync(fd),
    readSync: (fd, buffer, offset, length, position) => fsModule.readSync(fd, buffer, offset, length, position),
    writeSync: (fd, buffer, offset, length, position) => fsModule.writeSync(fd, buffer, offset, length, position),
    fstatSync: (fd) => fsModule.fstatSync(fd),
    ftruncateSync: (fd, length) => fsModule.ftruncateSync(fd, length),
    futimesSync: (fd, atime, mtime) => fsModule.futimesSync(fd, atime, mtime),
    statSync: (path) => fsModule.statSync(at(path)),
    lstatSync: (path) => fsModule.lstatSync(at(path)),
    mkdirSync: (path) => fsModule.mkdirSync(at(path)),
    readdirSync: (path, options) => fsModule.readdirSync(at(path), options),
    renameSync: (from, to) => fsModule.renameSync(at(from), at(to)),
    unlinkSync: (path) => fsModule.unlinkSync(at(path)),
    rmdirSync: (path) => fsModule.rmdirSync(at(path)),
    readlinkSync: (path) => fsModule.readlinkSync(at(path)),
    symlinkSync: (target, path) => fsModule.symlinkSync(target, at(path)),
    utimesSync: (path, atime, mtime) => fsModule.utimesSync(at(path), atime, mtime),
    truncateSync: (path, length) => fsModule.truncateSync(at(path), length)
  }
}

const wasmPath = fileURLToPath(new URL("../../../jj/wasm/flows_jj.wasm", import.meta.url))
const wasmBytes: Uint8Array | undefined = fsModule.existsSync(wasmPath)
  ? new Uint8Array(fsModule.readFileSync(wasmPath))
  : undefined

if (wasmBytes === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    "[BrowserHost.contract] packages/jj/wasm/flows_jj.wasm is not built — the jj capability "
      + "is asserted as the instantiation failure instead of the real-wasm contract. Build it "
      + "with `npm run build:wasm -w @smthrs/jj`."
  )
}

const host = fsModule.mkdtempSync(join(tmpdir(), "flows-browser-host-contract-"))
fsModule.mkdirSync(join(host, "repo"))

const layer = BrowserHost.layer({
  bash,
  fs: TestHost.makeMemoryFs(),
  jj: {
    // An empty module is deliberately invalid: with the artifact absent the
    // contract asserts the failure the layer actually reports.
    wasm: wasmBytes ?? new Uint8Array(0),
    fs: rootedSyncFs(host),
    root: "/repo"
  }
})

// The contract's jj probe is `status()` alone; seed one snapshot so the
// workspace exists before the probe, the way any real page's first write does.
beforeAll(async () => {
  if (wasmBytes === undefined) return
  fsModule.writeFileSync(join(host, "repo", "seed.txt"), "seed\n")
  const jj = await Effect.runPromise(Effect.provide(Jj, layer))
  await Effect.runPromise(jj.snapshot("browser host contract seed"))
}, 60_000)

afterAll(() => {
  fsModule.rmSync(host, { recursive: true, force: true })
})

runHostContract(
  "BrowserHost",
  layer,
  {
    fileSystem: { expected: "success", scratchPath: "/browser-host-contract" },
    path: { expected: "success" },
    childProcess: {
      expected: "success",
      execCommand: ChildProcess.make("host-contract-exec"),
      expectedStdout: "browser-exec",
      streamCommand: ChildProcess.make("host-contract-stream"),
      expectedStreamText: "browser-stream",
      optionsCommand: ChildProcess.make("host-contract-options", [], {
        cwd: "/",
        env: { HOST_CONTRACT_ENV: "browser" }
      }),
      expectedOptionsStdout: "browser-options",
      // just-bash runs a command line to completion; it has no stdin to feed.
      stdin: { expected: "failure", code: "BadArgument" },
      interruptCommand: ChildProcess.make("host-contract-interrupt")
    },
    jj: wasmBytes === undefined ? { expected: "failure", code: "unknown" } : { expected: "success" },
    httpClient: { expected: "failure", code: "TransportError" }
  }
)
