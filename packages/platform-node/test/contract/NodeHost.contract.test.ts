import { runHostContract } from "@smthrs/kernel/test/contract"
import { spawnSync } from "node:child_process"
import * as NodeHost from "../../src/NodeHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

runHostContract("NodeHost", NodeHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  childProcess: { expected: "success" },
  pty: { expected: "success" },
  jj: jjAvailable
    ? { expected: "success" }
    : { expected: "failure", code: "not_installed" },
  httpTransport: { expected: "failure", code: "TransportError" }
})
