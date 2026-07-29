import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as VercelFileSystem from "../src/VercelFileSystem.ts"

const blobDouble = () => {
  const values = new Map<string, Uint8Array>()
  return {
    binding: {
      get: async (key: string) => {
        const value = values.get(key)
        return value === undefined
          ? null
          : { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) }
      },
      put: async (key: string, value: Uint8Array) => {
        values.set(key, new Uint8Array(value))
      },
      del: async (key: string) => {
        values.delete(key)
      },
      list: async (options?: { readonly prefix?: string }) => ({
        blobs: [...values.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).map((pathname) => ({
          pathname
        }))
      })
    } satisfies VercelFileSystem.BlobBinding,
    values
  }
}

describe("VercelFileSystem", () => {
  it("persists files and infers directories over Blob keys", async () => {
    const blob = blobDouble()
    const fs = VercelFileSystem.make({ blob: blob.binding })
    const program = Effect.gen(function*() {
      yield* fs.makeDirectory("/workspace", { recursive: true })
      yield* fs.writeFile("/workspace/a.txt", new TextEncoder().encode("hello"))
      return {
        data: yield* fs.readFileString("/workspace/a.txt"),
        entries: yield* fs.readDirectory("/workspace"),
        exists: yield* fs.exists("/workspace/a.txt")
      }
    })
    await expect(Effect.runPromise(program)).resolves.toEqual({ data: "hello", entries: ["a.txt"], exists: true })
  })

  it("supports KV bindings with the same key semantics", async () => {
    const values = new Map<string, Uint8Array>()
    const fs = VercelFileSystem.make({
      kv: {
        get: async (key) => values.get(key) ?? null,
        set: async (key, value) => {
          values.set(key, value)
        },
        del: async (key) => {
          values.delete(key)
        },
        scan: async (prefix = "") => [...values.keys()].filter((key) => key.startsWith(prefix))
      }
    })
    await Effect.runPromise(fs.writeFile("/a", new TextEncoder().encode("x")))
    await expect(Effect.runPromise(fs.readFileString("/a"))).resolves.toBe("x")
  })

  it("reports watch as a typed platform error", async () => {
    const fs = VercelFileSystem.make({ blob: blobDouble().binding })
    await expect(Effect.runPromise(Stream.runCollect(fs.watch("/")))).rejects.toMatchObject({
      reason: { _tag: "Unknown" }
    })
  })
})
