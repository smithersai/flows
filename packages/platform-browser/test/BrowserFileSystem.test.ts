/**
 * The adapter is exercised two ways.
 *
 * Error mapping runs against stub backends, because the point is which thrown
 * value produces which `PlatformError` tag — a real backend cannot be made to
 * throw `EACCES` on demand. The operations run against **`node:fs/promises` in a
 * temp directory**: it satisfies `ZenFsPromisesLike` structurally, which is the
 * whole reason the seam is a structural slice, so the contract is checked
 * against a real filesystem rather than against a second in-memory
 * implementation we would then have to keep honest.
 */
import { Cause, Effect, Option, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as BrowserFileSystem from "../src/BrowserFileSystem.ts"

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

  it("reports an undecodable encoding as a BadArgument rather than a system failure", async () => {
    const fileSystem = BrowserFileSystem.make({
      ...throwingFs(codeError("ENOENT")),
      readFile: async () => encoder.encode("alpha")
    })

    const error = await Effect.runPromise(
      Effect.flip(fileSystem.readFileString("/p", "not-a-real-encoding"))
    )

    expect(error.reason).toMatchObject({
      _tag: "BadArgument",
      method: "readFileString",
      description: "invalid encoding"
    })
  })

  it("reports an unencodable string as a BadArgument before touching the backend", async () => {
    const written: Array<unknown> = []
    const fileSystem = BrowserFileSystem.make({
      ...throwingFs(codeError("ENOENT")),
      writeFile: async (_path, data) => {
        written.push(data)
      }
    })
    /** `TextEncoder.encode` coerces its argument, so a throwing `toString` is the only way in. */
    const hostile = {
      toString: (): string => {
        throw new Error("not stringifiable")
      }
    } as unknown as string

    const error = await Effect.runPromise(Effect.flip(fileSystem.writeFileString("/p", hostile)))

    expect(error.reason).toMatchObject({
      _tag: "BadArgument",
      method: "writeFileString",
      description: "could not encode string"
    })
    expect(written).toEqual([])
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
})

describe("BrowserFileSystem operations over node:fs/promises", () => {
  let root: string

  /**
   * `node:fs/promises` is a structural `ZenFsPromisesLike`: the slice was drawn
   * so that it is. Nothing here is cast — if the shapes drift, this line stops
   * compiling, which is the point.
   */
  const backend: BrowserFileSystem.ZenFsPromisesLike = NodeFsPromises
  const fileSystem = BrowserFileSystem.make(backend)
  const path = (...segments: ReadonlyArray<string>): string => join(root, ...segments)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "flows-platform-browser-fs-"))
    await NodeFsPromises.mkdir(join(root, "sub"), { recursive: true })
    await NodeFsPromises.writeFile(join(root, "a.txt"), encoder.encode("alpha"))
    await NodeFsPromises.writeFile(join(root, "sub", "b.txt"), encoder.encode("beta"))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("round-trips a written file and reports it as existing", async () => {
    const contents = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fileSystem.writeFile(path("c.txt"), encoder.encode("gamma"))
        const bytes = yield* fileSystem.readFile(path("c.txt"))
        const exists = yield* fileSystem.exists(path("c.txt"))
        const missing = yield* fileSystem.exists(path("nope.txt"))
        return { text: decoder.decode(bytes), exists, missing }
      })
    )

    expect(contents).toEqual({ text: "gamma", exists: true, missing: false })
  })

  /**
   * `makeNoop` hardcodes both string helpers to `NotFound` instead of deriving
   * them from `readFile`/`writeFile` the way `make` does, so these pin that the
   * adapter wires them up rather than inheriting the stub.
   */
  it("round-trips a string through the derived string helpers", async () => {
    const text = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fileSystem.writeFileString(path("s.txt"), "delta")
        return yield* fileSystem.readFileString(path("s.txt"))
      })
    )

    expect(text).toBe("delta")
  })

  /**
   * Dropping `flag` would silently turn an append into a truncating write, so
   * it is forwarded to the backend rather than ignored.
   */
  it("forwards `flag` so an append extends the file and `wx` refuses to clobber", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fileSystem.writeFileString(path("log.txt"), "one\n")
        yield* fileSystem.writeFileString(path("log.txt"), "two\n", { flag: "a" })
        yield* fileSystem.writeFile(path("log.txt"), encoder.encode("three\n"), { flag: "a", mode: 0o644 })
        const appended = yield* fileSystem.readFileString(path("log.txt"))
        const clobber = yield* Effect.flip(
          fileSystem.writeFile(path("log.txt"), encoder.encode("x"), { flag: "wx" })
        )
        return { appended, clobber }
      })
    )

    expect(outcome.appended).toBe("one\ntwo\nthree\n")
    expect(outcome.clobber.reason).toMatchObject({ _tag: "AlreadyExists", method: "writeFile" })
  })

  it("stats files and directories with the corresponding type, size, and mtime", async () => {
    const [file, directory] = await Effect.runPromise(
      Effect.all([fileSystem.stat(path("a.txt")), fileSystem.stat(path("sub"))])
    )

    expect(file.type).toBe("File")
    expect(Number(file.size)).toBe(5)
    expect(Option.getOrThrow(file.mtime)).toBeInstanceOf(Date)
    expect(directory.type).toBe("Directory")
  })

  it("creates directories recursively and lists their entries", async () => {
    const entries = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fileSystem.makeDirectory(path("deep", "nested"), { recursive: true })
        yield* fileSystem.writeFile(path("deep", "nested", "z.txt"), encoder.encode("z"))
        return yield* fileSystem.readDirectory(path("deep", "nested"))
      })
    )

    expect(entries).toEqual(["z.txt"])
  })

  it("fails a non-recursive makeDirectory whose parent is missing", async () => {
    const error = await Effect.runPromise(
      Effect.flip(fileSystem.makeDirectory(path("absent", "child")))
    )

    expect(error.reason).toMatchObject({ _tag: "NotFound", method: "makeDirectory" })
  })

  it("resolves realPath and access only for paths that exist", async () => {
    await expect(Effect.runPromise(fileSystem.realPath(path("a.txt")))).resolves.toBe(path("a.txt"))
    await expect(Effect.runPromise(fileSystem.access(path("a.txt")))).resolves.toBeUndefined()
    await expect(Effect.runPromise(Effect.flip(fileSystem.realPath(path("gone"))))).resolves.toMatchObject({
      reason: { _tag: "NotFound", method: "realPath" }
    })
    await expect(Effect.runPromise(Effect.flip(fileSystem.access(path("gone"))))).resolves.toMatchObject({
      reason: { _tag: "NotFound", method: "access" }
    })
  })

  it("removes recursively, tolerates a forced removal of a missing path, and fails otherwise", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fileSystem.remove(path("sub"), { recursive: true })
        yield* fileSystem.remove(path("never"), { force: true })
        const failure = yield* Effect.flip(fileSystem.remove(path("never")))
        const exists = yield* fileSystem.exists(path("sub"))
        return { failure, exists }
      })
    )

    expect(outcome.exists).toBe(false)
    expect(outcome.failure).toMatchObject({ reason: { _tag: "NotFound", method: "remove" } })
  })

  it("streams a whole file when no bounds are given", async () => {
    const chunks = await Effect.runPromise(Stream.runCollect(fileSystem.stream(path("a.txt"))))

    expect(Array.from(chunks).map((chunk) => decoder.decode(chunk)).join("")).toBe("alpha")
  })

  it("emits nothing when `bytesToRead` is zero and clamps a negative offset to the start", async () => {
    const empty = await Effect.runPromise(
      Stream.runCollect(fileSystem.stream(path("a.txt"), { bytesToRead: 0 }))
    )
    const clamped = await Effect.runPromise(
      Stream.runCollect(fileSystem.stream(path("a.txt"), { offset: -10, chunkSize: 2 }))
    )

    expect(Array.from(empty)).toEqual([])
    expect(Array.from(clamped).map((chunk) => decoder.decode(chunk))).toEqual(["al", "ph", "a"])
  })

  it("truncates the final chunk when fewer bytes remain than the chunk size", async () => {
    const chunks = await Effect.runPromise(
      Stream.runCollect(fileSystem.stream(path("a.txt"), { offset: 3, bytesToRead: 99, chunkSize: 4 }))
    )

    expect(Array.from(chunks).map((chunk) => chunk.length)).toEqual([2])
    expect(decoder.decode(Array.from(chunks)[0])).toBe("ha")
  })
})
