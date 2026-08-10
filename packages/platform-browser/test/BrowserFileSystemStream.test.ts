import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as BrowserFileSystem from "../src/BrowserFileSystem.ts"

describe("BrowserFileSystem", () => {
  // Stream completion is the condition; a wall-clock limit only measures
  // machine load, which the package-wide `testTimeout` budgets for.
  it("streams bounded chunks without loading the complete file", async () => {
    const source = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251)
    let closed = false
    let largestRead = 0
    const backend: BrowserFileSystem.ZenFsPromisesLike = {
      open: async () => ({
        read: async (buffer, offset, length, position) => {
          largestRead = Math.max(largestRead, buffer.length)
          const bytesRead = Math.min(length, source.length - position)
          if (bytesRead > 0) {
            buffer.set(source.subarray(position, position + bytesRead), offset)
          }
          return { bytesRead }
        },
        close: async () => {
          closed = true
        }
      }),
      readFile: async () => {
        throw new Error("stream must not call readFile")
      },
      writeFile: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({
        size: source.length,
        mode: 0,
        mtimeMs: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false
      }),
      rm: async () => {}
    }
    const fileSystem = BrowserFileSystem.make(backend)

    const chunks = await Effect.runPromise(
      fileSystem.stream("/large", {
        offset: 17,
        bytesToRead: 100_000,
        chunkSize: 4_096
      }).pipe(Stream.runCollect)
    )
    const bytes = Uint8Array.from(Array.from(chunks).flatMap((chunk) => [...chunk]))

    expect(bytes).toEqual(source.subarray(17, 100_017))
    expect(largestRead).toBeLessThanOrEqual(4_096)
    expect(closed).toBe(true)
  })
})
