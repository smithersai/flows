import * as TestHost from "../../src/test/TestHost.ts"
import { runHostContract } from "./HostContract.ts"

runHostContract(
  "TestHost",
  TestHost.layer({
    files: {},
    commands: {
      "host-contract-exec": { stdout: "test-exec" },
      "host-contract-stream": { stdout: "test-stream" },
      "host-contract-options": { stdout: "test-options" },
      "host-contract-timeout": { stdout: "too-late", delayMs: 25 },
      "host-contract-interrupt": { stdout: "" }
    }
  }),
  {
    fileSystem: { expected: "success", scratchPath: "/test-host-contract" },
    path: { expected: "success" },
    shell: {
      expected: "success",
      execCommand: "host-contract-exec",
      expectedStdout: "test-exec",
      streamCommand: "host-contract-stream",
      expectedStreamText: "test-stream",
      optionsCommand: "host-contract-options",
      options: { cwd: "/", env: { HOST_CONTRACT_ENV: "test" } },
      expectedOptionsStdout: "test-options",
      timeoutCommand: "host-contract-timeout",
      timeoutMs: 1,
      timeoutAdvanceMs: 2,
      interruptCommand: "host-contract-interrupt"
    },
    pty: { expected: "failure", code: "unsupported" },
    jj: { expected: "failure", code: "not_installed" },
    httpTransport: { expected: "failure", code: "TransportError" }
  }
)
