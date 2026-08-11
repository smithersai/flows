import { runHostContract } from "@smthrs/kernel/test/contract"
import * as TestHost from "@smthrs/kernel/test/TestHost"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
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

runHostContract(
  "BrowserHost",
  BrowserHost.layer({
    bash,
    fs: TestHost.makeMemoryFs()
  }),
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
    jj: { expected: "failure", code: "not_installed" },
    httpTransport: { expected: "failure", code: "TransportError" }
  }
)
