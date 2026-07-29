import * as BrowserHost from "../../src/browser/BrowserHost.ts"
import type * as JustBashShell from "../../src/browser/JustBashShell.ts"
import * as TestHost from "../../src/test/TestHost.ts"
import { runHostContract } from "./HostContract.ts"

type BashResult = Awaited<ReturnType<JustBashShell.JustBashLike["run"]>>

const result = (stdout: string): BashResult => ({ stdout, stderr: "", exitCode: 0 })

const bash: JustBashShell.JustBashLike = {
  run: (command, options) => {
    if (command === "host-contract-timeout") {
      return new Promise<BashResult>((resolve) => {
        setTimeout(() => resolve(result("too-late")), 25)
      })
    }
    if (command === "host-contract-exec") return Promise.resolve(result("browser-exec"))
    if (command === "host-contract-stream") return Promise.resolve(result("browser-stream"))
    if (command === "host-contract-options") {
      const valid = options?.cwd === "/" && options.env?.HOST_CONTRACT_ENV === "browser"
      return Promise.resolve(result(valid ? "browser-options" : "invalid-options"))
    }
    return Promise.resolve(result(""))
  },
  getCwd: () => "/"
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
    shell: {
      expected: "success",
      execCommand: "host-contract-exec",
      expectedStdout: "browser-exec",
      streamCommand: "host-contract-stream",
      expectedStreamText: "browser-stream",
      optionsCommand: "host-contract-options",
      options: { cwd: "/", env: { HOST_CONTRACT_ENV: "browser" } },
      expectedOptionsStdout: "browser-options",
      timeoutCommand: "host-contract-timeout",
      interruptCommand: "host-contract-interrupt"
    },
    pty: { expected: "failure", code: "unsupported" },
    jj: { expected: "failure", code: "not_installed" },
    httpTransport: { expected: "failure", code: "TransportError" }
  }
)
