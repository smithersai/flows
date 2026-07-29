import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as CloudflareFileSystem from "../src/CloudflareFileSystem.ts"

describe("CloudflareFileSystem", () => {
  it("persists injected objects", async () => {
    const values = new Map<string, Uint8Array>()
    const fs = CloudflareFileSystem.make({
      get: async (key) => values.get(key),
      put: async (key, value) => {
        values.set(key, value)
      },
      delete: async (key) => {
        values.delete(key)
      },
      list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix))
    })
    await Effect.runPromise(fs.writeFile("a", new Uint8Array([1])))
    expect(await Effect.runPromise(fs.readFile("a"))).toEqual(new Uint8Array([1]))
  })
})
