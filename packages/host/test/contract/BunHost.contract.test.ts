/**
 * Contract for the layer `BunHost` selects on the current runtime.
 *
 * Under Node — which is what vitest and CI run — `BunShell.layer` and its
 * siblings resolve to the Node implementations by design, so these assertions
 * describe the fallback, NOT the `Bun.spawn` code paths. Those are owned by
 * `test/BunShell.test.ts`, which drives `BunShell.make` with an explicit fake
 * Bun runtime; keep new Bun-only behaviour covered there.
 */
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
