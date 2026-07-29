import { Effect, FileSystem } from "effect"
import { describe, expect, it } from "vitest"
import { layerEphemeral } from "../src/node/NodeVercelHost.ts"

describe("NodeVercelHost", () => {
  it("confines file operations to /tmp", async () => {
    const layer = layerEphemeral("/tmp/flows-vercel-test")
    const write = Effect.provide(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return yield* fs.writeFile("/etc/flows-vercel-escape", new TextEncoder().encode("no"))
      }),
      layer
    )
    await expect(Effect.runPromise(write)).rejects.toBeDefined()
  })

  it("writes inside the invocation root", async () => {
    const layer = layerEphemeral("/tmp/flows-vercel-test")
    const write = Effect.provide(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory("/tmp/flows-vercel-test", { recursive: true })
        yield* fs.writeFile("/tmp/flows-vercel-test/file", new TextEncoder().encode("ok"))
        return yield* fs.readFileString("/tmp/flows-vercel-test/file")
      }),
      layer
    )
    await expect(Effect.runPromise(write)).resolves.toBe("ok")
  })
})
