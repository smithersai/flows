import { Cause, Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as BrowserFileSystem from "../src/browser/BrowserFileSystem.ts"
import { makeMemoryFs } from "../src/test/TestHost.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** A backend where every method rejects with the same value, to pin error mapping. */
const throwingFs = (cause: unknown): BrowserFileSystem.ZenFsPromisesLike => {
  const boom = async (): Promise<never> => {
    throw cause
  }
  return {
    open: boom,
    readFile: boom,
    writeFile: boom,
    mkdir: boom,
    readdir: boom,
    stat: boom,
    rm: boom
  }
}

const codeError = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code })

describe("BrowserFileSystem error mapping", () => {
  it("maps ENOENT to NotFound, EEXIST to AlreadyExists, and anything else to Unknown", async () => {
    const cases = [
      [codeError("ENOENT"), "NotFound"],
      [codeError("EEXIST"), "AlreadyExists"],
      [codeError("EACCES"), "Unknown"]
    ] as const

    for (const [cause, tag] of cases) {
      const fileSystem = BrowserFileSystem.make(throwingFs(cause))
      const error = await Effect.runPromise(Effect.flip(fileSystem.readFile("/denied")))

      expect(error.reason).toMatchObject({
        _tag: tag,
        method: "readFile",
        pathOrDescriptor: "/denied",
        description: `${(cause as Error & { code: string }).code}: boom`,
        cause
      })
    }
  })

  it("stringifies a non-Error rejection value into the description", async () => {
    const fileSystem = BrowserFileSystem.make(throwingFs("plain string failure"))

    const error = await Effect.runPromise(Effect.flip(fileSystem.stat("/x")))

    expect(error.reason._tag).toBe("Unknown")
    expect(error.reason.description).toBe("plain string failure")
  })

  it("names the failing method for every wired operation", async () => {
    const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))
    const operations: ReadonlyArray<
      readonly [string, Effect.Effect<unknown, { readonly reason: { readonly method: string } }>]
    > = [
      ["readFile", fileSystem.readFile("/p")],
      ["writeFile", fileSystem.writeFile("/p", encoder.encode("x"))],
      ["makeDirectory", fileSystem.makeDirectory("/p")],
      ["readDirectory", fileSystem.readDirectory("/p")],
      ["stat", fileSystem.stat("/p")],
      ["realPath", fileSystem.realPath("/p")],
      ["remove", fileSystem.remove("/p")],
      ["access", fileSystem.access("/p")],
      ["stream", Stream.runCollect(fileSystem.stream("/p"))]
    ]

    for (const [method, effect] of operations) {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error.reason.method).toBe(method)
    }
  })

  it("reports `exists` as false on failure rather than failing", async () => {
    const fileSystem = BrowserFileSystem.make(throwingFs(codeError("ENOENT")))

    await expect(Effect.runPromise(fileSystem.exists("/missing"))).resolves.toBe(false)
  })

  it("dies rather than fails when closing a streamed handle throws", async () => {
    const backend: BrowserFileSystem.ZenFsPromisesLike = {
      ...throwingFs(codeError("ENOENT")),
      open: async () => ({
        read: async () => ({ bytesRead: 0 }),
        close: async () => {
          throw codeError("EIO")
        }
      })
    }
    const fileSystem = BrowserFileSystem.make(backend)

    const exit = await Effect.runPromiseExit(Stream.runCollect(fileSystem.stream("/p")))

    expect(exit._tag).toBe("Failure")
    const defect = exit._tag === "Failure" ? Cause.findDefect(exit.cause) : undefined
    expect(defect).toMatchObject({
      _tag: "Success",
      success: { reason: { _tag: "Unknown", method: "stream.close" } }
    })
  })
})

describe("BrowserFileSystem operations", () => {
  const fileSystem = () => BrowserFileSystem.make(makeMemoryFs({ "/w/a.txt": "alpha", "/w/sub/b.txt": "beta" }))

  it("round-trips a written file and reports it as existing", async () => {
    const fs = fileSystem()

    const contents = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fs.writeFile("/w/c.txt", encoder.encode("gamma"))
        const bytes = yield* fs.readFile("/w/c.txt")
        const exists = yield* fs.exists("/w/c.txt")
        const missing = yield* fs.exists("/w/nope.txt")
        return { text: decoder.decode(bytes), exists, missing }
      })
    )

    expect(contents).toEqual({ text: "gamma", exists: true, missing: false })
  })

  it("stats files and directories with the corresponding type and mtime", async () => {
    const fs = fileSystem()

    const [file, directory] = await Effect.runPromise(
      Effect.all([fs.stat("/w/a.txt"), fs.stat("/w/sub")])
    )

    expect(file.type).toBe("File")
    expect(Number(file.size)).toBe(5)
    expect(Option.getOrThrow(file.mtime)).toEqual(new Date(0))
    expect(directory.type).toBe("Directory")
    expect(Number(directory.size)).toBe(0)
  })

  it("reports SymbolicLink and Unknown for stats that are neither file nor directory", async () => {
    const stats = (kind: "link" | "other"): BrowserFileSystem.ZenFsStatsLike => ({
      size: 0,
      mode: 0,
      mtimeMs: 0,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => kind === "link"
    })
    const make = (kind: "link" | "other") =>
      BrowserFileSystem.make({ ...throwingFs(codeError("ENOENT")), stat: async () => stats(kind) })

    await expect(Effect.runPromise(make("link").stat("/l"))).resolves.toMatchObject({ type: "SymbolicLink" })
    await expect(Effect.runPromise(make("other").stat("/o"))).resolves.toMatchObject({ type: "Unknown" })
  })

  it("creates directories recursively and lists their sorted entries", async () => {
    const fs = fileSystem()

    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fs.makeDirectory("/w/deep/nested", { recursive: true })
        yield* fs.writeFile("/w/deep/nested/z.txt", encoder.encode("z"))
        return yield* fs.readDirectory("/w")
      })
    )

    expect(entries).toEqual(["a.txt", "deep", "sub"])
  })

  it("resolves realPath and access only for paths that exist", async () => {
    const fs = fileSystem()

    await expect(Effect.runPromise(fs.realPath("/w/a.txt"))).resolves.toBe("/w/a.txt")
    await expect(Effect.runPromise(fs.access("/w/a.txt"))).resolves.toBeUndefined()
    await expect(Effect.runPromise(Effect.flip(fs.realPath("/w/gone")))).resolves.toMatchObject({
      reason: { _tag: "NotFound", method: "realPath" }
    })
    await expect(Effect.runPromise(Effect.flip(fs.access("/w/gone")))).resolves.toMatchObject({
      reason: { _tag: "NotFound", method: "access" }
    })
  })

  it("removes recursively, tolerates a forced removal of a missing path, and fails otherwise", async () => {
    const fs = fileSystem()

    const remaining = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fs.remove("/w/sub", { recursive: true })
        yield* fs.remove("/w/never", { force: true })
        const failure = yield* Effect.flip(fs.remove("/w/never"))
        const listing = yield* fs.readDirectory("/w")
        return { failure, listing }
      })
    )

    expect(remaining.listing).toEqual(["a.txt"])
    expect(remaining.failure).toMatchObject({ reason: { _tag: "NotFound", method: "remove" } })
  })

  it("streams a whole file when no bounds are given", async () => {
    const fs = fileSystem()

    const chunks = await Effect.runPromise(Stream.runCollect(fs.stream("/w/a.txt")))

    expect(Array.from(chunks).map((chunk) => decoder.decode(chunk)).join("")).toBe("alpha")
  })

  it("emits nothing when `bytesToRead` is zero and clamps a negative offset to the start", async () => {
    const fs = fileSystem()

    const empty = await Effect.runPromise(Stream.runCollect(fs.stream("/w/a.txt", { bytesToRead: 0 })))
    const clamped = await Effect.runPromise(
      Stream.runCollect(fs.stream("/w/a.txt", { offset: -10, chunkSize: 2 }))
    )

    expect(Array.from(empty)).toEqual([])
    expect(Array.from(clamped).map((chunk) => decoder.decode(chunk))).toEqual(["al", "ph", "a"])
  })

  it("truncates the final chunk when fewer bytes remain than the chunk size", async () => {
    const fs = fileSystem()

    const chunks = await Effect.runPromise(
      Stream.runCollect(fs.stream("/w/a.txt", { offset: 3, bytesToRead: 99, chunkSize: 4 }))
    )

    expect(Array.from(chunks).map((chunk) => chunk.length)).toEqual([2])
    expect(decoder.decode(Array.from(chunks)[0])).toBe("ha")
  })
})
