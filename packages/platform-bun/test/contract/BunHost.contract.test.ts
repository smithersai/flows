/**
 * Contract for the layer `BunHost` selects on the current runtime.
 *
 * Under Node — which is what vitest and CI run — the Bun modules resolve to
 * Node implementations by design, so these assertions describe the fallback,
 * NOT the Bun-only code paths. `@effect/platform-bun`'s
 * `BunChildProcessSpawner` is `@effect/platform-node-shared`'s spawner
 * re-exported, so process spawning is literally the same implementation on
 * both runtimes and needs no separate Bun fake.
 */
import { runHostContract } from "@smthrs/kernel/test/contract"
import { spawnSync } from "node:child_process"
import * as BunHost from "../../src/BunHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

runHostContract("BunHost", BunHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  childProcess: { expected: "success" },
  pty: { expected: "success" },
  jj: jjAvailable
    ? { expected: "success" }
    : { expected: "failure", code: "not_installed" },
  httpTransport: { expected: "failure", code: "TransportError" }
})
