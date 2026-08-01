import { spawnSync } from "node:child_process"
import * as NodeHost from "../../src/node/NodeHost.ts"
import { runHostContract } from "./HostContract.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

runHostContract("NodeHost", NodeHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  shell: {
    expected: "success",
    options: {
      cwd: "/tmp",
      env: { HOST_CONTRACT_ENV: "env" },
      stdin: "stdin\n"
    }
  },
  pty: { expected: "success" },
  jj: jjAvailable
    ? { expected: "success" }
    : { expected: "failure", code: "not_installed" },
  httpTransport: { expected: "failure", code: "TransportError" }
})
