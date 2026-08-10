/**
 * The barrel and the aggregate layer. `BrowserServices.layer` has no behaviour
 * of its own, so the assertion is that every tag it promises is present and
 * that the spawner it wires up is the one talking to the filesystem it wires
 * up — the failure mode the function signature exists to prevent.
 */
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as NodeFsPromises from "node:fs/promises"
import { describe, expect, it } from "vitest"
import * as BrowserChildProcessSpawner from "../src/BrowserChildProcessSpawner.ts"
import * as BrowserFileSystem from "../src/BrowserFileSystem.ts"
import * as BrowserServices from "../src/BrowserServices.ts"
import * as Index from "../src/index.ts"

const bash: BrowserChildProcessSpawner.JustBashLike = {
  run: async (command) => ({ stdout: command, stderr: "", exitCode: 0 })
}

describe("@smthrs/platform-browser barrel", () => {
  it("re-exports every module as a namespace", () => {
    expect(Object.keys(Index).sort()).toEqual(
      ["BrowserChildProcessSpawner", "BrowserFileSystem", "BrowserServices"].sort()
    )
    expect(Index.BrowserChildProcessSpawner.layer).toBe(BrowserChildProcessSpawner.layer)
    expect(Index.BrowserFileSystem.layer).toBe(BrowserFileSystem.layer)
    expect(Index.BrowserServices.layer).toBe(BrowserServices.layer)
  })
})

describe("BrowserServices", () => {
  it("provides the spawner, the filesystem, and the path service from one layer", async () => {
    const services = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        return {
          spawned: typeof spawner.spawn,
          exists: yield* fs.exists("/definitely-not-a-real-path"),
          normalized: path.normalize("/a/./b/../c")
        }
      }).pipe(Effect.provide(BrowserServices.layer({ bash, fs: NodeFsPromises })))
    )

    expect(services).toEqual({ spawned: "function", exists: false, normalized: "/a/c" })
  })
})
