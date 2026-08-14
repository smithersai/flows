import { runHostContract } from "@smthrs/kernel-next/test/contract"
import { spawnSync } from "node:child_process"
import * as NodeHost from "../../src/NodeHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0
const jjStatusWorks = jjAvailable && spawnSync("jj", ["status"], { stdio: "ignore" }).status === 0

runHostContract("NodeHost", NodeHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  childProcess: { expected: "success" },
  jj: jjStatusWorks
    ? { expected: "success" }
    : { expected: "failure", code: jjAvailable ? "unknown" : "not_installed" },
  httpClient: { expected: "failure", code: "TransportError" }
})
