import { spawnSync } from "node:child_process"
import * as BunHost from "../../src/bun/BunHost.ts"
import { runHostContract } from "./HostContract.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

runHostContract("BunHost", BunHost.layer, {
  fileSystem: {
    expected: "success",
    scratchPath: `/tmp/flows-bun-host-contract-${process.pid}`
  },
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
