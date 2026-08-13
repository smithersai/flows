import { isJjError, Jj } from "@smthrs/jj-next"
import * as BrowserFileSystem from "@smthrs/platform-browser-next/BrowserFileSystem"
import { Clock, Effect, FileSystem, Random, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as HttpClient from "../src/HttpClient.ts"
import * as TestHost from "../src/test/TestHost.ts"

const decoder = new TextDecoder()

describe("TestHost memory filesystem", () => {
  it("collapses `.`, `..`, and trailing slashes onto one key", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/a/b/c.txt": "seed" }))

    const reads = await Effect.runPromise(
      Effect.all([
        fs.readFile("/a/b/c.txt"),
        fs.readFile("/a/./b/c.txt"),
        fs.readFile("/a/x/../b/c.txt"),
        fs.readFile("//a//b//c.txt")
      ])
    )

    expect(reads.map((bytes) => decoder.decode(bytes))).toEqual(["seed", "seed", "seed", "seed"])
  })

  it("creates parent directories for a seeded file so its directory is listable", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/deep/nest/file.txt": "x" }))

    const listing = await Effect.runPromise(Effect.all([fs.readDirectory("/"), fs.readDirectory("/deep")]))

    expect(listing).toEqual([["deep"], ["nest"]])
  })

  it("does not materialize parents for a non-recursive mkdir, though listings derive their names", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs())

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* fs.makeDirectory("/one/two")
        const listedRoot = yield* fs.readDirectory("/")
        const missingParent = yield* Effect.flip(fs.stat("/one"))
        return { listedRoot, missingParent }
      })
    )

    expect(result.listedRoot).toEqual(["one"])
    expect(result.missingParent).toMatchObject({ reason: { _tag: "NotFound", method: "stat" } })
  })

  it("refuses to open or read a directory as a file", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/dir/f.txt": "x" }))

    const errors = await Effect.runPromise(
      Effect.all([
        Effect.flip(fs.readFile("/dir")),
        Effect.flip(Stream.runCollect(fs.stream("/dir")))
      ])
    )

    expect(errors.map((error) => error.reason._tag)).toEqual(["NotFound", "NotFound"])
  })

  it("reads past the end of a file as zero bytes instead of throwing", async () => {
    const fs = BrowserFileSystem.make(TestHost.makeMemoryFs({ "/f.txt": "ab" }))

    const chunks = await Effect.runPromise(Stream.runCollect(fs.stream("/f.txt", { offset: 99 })))

    expect(Array.from(chunks)).toEqual([])
  })
})

describe("TestHost scripted commands", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner>,
    commands?: Readonly<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>
  ) => Effect.runPromise(Effect.provide(effect, TestHost.layer(commands === undefined ? {} : { commands })))

  const outcome = (command: ChildProcess.Command) =>
    Effect.flatMap(ChildProcessSpawner, (spawner) =>
      Effect.all({
        stdout: spawner.string(command),
        stderr: Stream.mkString(spawner.streamString(command, { includeStderr: true })),
        exitCode: spawner.exitCode(command)
      }))

  it("reports an unlisted command the way a shell reports a missing binary", async () => {
    const result = await run(outcome(ChildProcess.make("curl", ["https://example.com"])))

    expect(result).toEqual({
      stdout: "",
      stderr: "command not found: curl https://example.com\n",
      exitCode: 127
    })
  })

  it("defaults every unscripted field of a declared command", async () => {
    const result = await run(outcome(ChildProcess.make("noop")), { noop: {} })

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  it("emits stdout and stderr as one chunk each and omits empty ones", async () => {
    const collect = (name: string) =>
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        Effect.scoped(
          Effect.gen(function*() {
            const handle = yield* spawner.spawn(ChildProcess.make(name))
            const chunks = <E>(stream: Stream.Stream<Uint8Array, E>) =>
              Effect.map(Stream.runCollect(stream), (values) => Array.from(values, (v) => decoder.decode(v)))
            return { stdout: yield* chunks(handle.stdout), stderr: yield* chunks(handle.stderr) }
          })
        ))

    const [both, onlyErr, silent] = await run(
      Effect.all([collect("both"), collect("only-err"), collect("silent")]),
      {
        both: { stdout: "out", stderr: "err", exitCode: 1 },
        "only-err": { stderr: "bad" },
        silent: {}
      }
    )

    expect(both).toEqual({ stdout: ["out"], stderr: ["err"] })
    expect(onlyErr).toEqual({ stdout: [], stderr: ["bad"] })
    expect(silent).toEqual({ stdout: [], stderr: [] })
  })
})

describe("TestHost determinism", () => {
  it("produces the same random sequence for the same seed and a different one otherwise", async () => {
    const draw = Effect.gen(function*() {
      const random = yield* Random.Random
      return [random.nextDoubleUnsafe(), random.nextDoubleUnsafe(), random.nextIntUnsafe()]
    })

    const first = await Effect.runPromise(Effect.provide(draw, TestHost.layer({ seed: 7 })))
    const second = await Effect.runPromise(Effect.provide(draw, TestHost.layer({ seed: 7 })))
    const other = await Effect.runPromise(Effect.provide(draw, TestHost.layer({ seed: 8 })))

    expect(first).toEqual(second)
    expect(first).not.toEqual(other)
    for (const value of first.slice(0, 2)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
    expect(Number.isInteger(first[2])).toBe(true)
  })

  it("holds the clock still until a test advances it", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const before = yield* Clock.currentTimeMillis
        yield* TestClock.adjust("5 seconds")
        const after = yield* Clock.currentTimeMillis
        return { before, after }
      }).pipe(Effect.provide(TestHost.TestHost))
    )

    expect(observed.before).toBe(0)
    expect(observed.after).toBe(5_000)
  })

  it("starts the zero-config bundle with an empty filesystem and no scripted commands", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner
        return {
          root: yield* fs.readDirectory("/"),
          exit: yield* spawner.exitCode(ChildProcess.make("ls"))
        }
      }).pipe(Effect.provide(TestHost.TestHost))
    )

    expect(state).toEqual({ root: [], exit: 127 })
  })
})

describe("TestHost unsupported services", () => {
  it("fails every jj method with `not_installed` and the command it would have run", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const jj = yield* Jj
        return yield* Effect.all([
          Effect.flip(jj.snapshot("msg")),
          Effect.flip(jj.restore("abc")),
          Effect.flip(jj.diff("a", "b")),
          Effect.flip(jj.workspaceAdd("lane", "/tmp/lane")),
          Effect.flip(jj.workspaceForget("lane")),
          Effect.flip(jj.status())
        ])
      }).pipe(Effect.provide(TestHost.TestHost))
    )

    const jjErrors = errors.map((error) => {
      if (!isJjError(error)) throw new Error("the test host's jj layer only fails with JjError")
      return error
    })
    expect(jjErrors.map((error) => error.command)).toEqual([
      "jj commit",
      "jj edit",
      "jj diff",
      "jj workspace add",
      "jj workspace forget",
      "jj status"
    ])
    expect(new Set(jjErrors.map((error) => error.code))).toEqual(new Set(["not_installed"]))
  })

  it("fails HTTP requests through the noop client", async () => {
    const client = HttpClient.makeNoop()

    const error = await Effect.runPromise(Effect.flip(client.get("https://example.com")))

    expect(error.reason._tag).toBe("TransportError")
  })
})

describe("TestHost memory filesystem edges", () => {
  it("refuses to list a file as a directory", async () => {
    const memory = TestHost.makeMemoryFs({ "/dir/f.txt": "x" })

    await expect(memory.readdir("/dir/f.txt")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(memory.readdir("/dir")).resolves.toEqual(["f.txt"])
  })

  it("reports files and directories as such, and never as symbolic links", async () => {
    const memory = TestHost.makeMemoryFs({ "/dir/f.txt": "abc" })

    const file = await memory.stat("/dir/f.txt")
    const directory = await memory.stat("/dir")

    expect([file.isFile(), file.isDirectory(), file.isSymbolicLink()]).toEqual([true, false, false])
    expect([directory.isFile(), directory.isDirectory(), directory.isSymbolicLink()]).toEqual([false, true, false])
  })

  it("lists a nested path under its immediate parent name only once", async () => {
    const memory = TestHost.makeMemoryFs({ "/a/b/c.txt": "x", "/a/b/d.txt": "y", "/a/top.txt": "z" })

    expect(await memory.readdir("/a")).toEqual(["b", "top.txt"])
  })
})

describe("TestHost scripted interpreter latency", () => {
  /**
   * `delayMs` is the bundle's one concession to real time: a scripted command
   * can take a while, so a test can interleave work with a slow command or put
   * an `Effect.timeout` around one. Nothing else in the bundle moves without a
   * `TestClock.adjust`, so the knob is worth pinning.
   */
  it("holds a scripted command open for its declared delay", async () => {
    const bash = TestHost.makeStubBash({ slow: { stdout: "late", delayMs: 5 } })

    const started = performance.now()
    const result = await bash.run("slow")

    expect(result).toEqual({ stdout: "late", stderr: "", exitCode: 0 })
    expect(performance.now() - started).toBeGreaterThanOrEqual(4)
  })
})
