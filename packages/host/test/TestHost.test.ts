import { Jj } from "@smthrs/jj"
import { Pty } from "@smthrs/pty"
import { Clock, Effect, FileSystem, Random, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as BrowserFileSystem from "../src/browser/BrowserFileSystem.ts"
import * as JustBashShell from "../src/browser/JustBashShell.ts"
import * as HttpTransport from "../src/HttpTransport.ts"
import { Shell } from "../src/Shell.ts"
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

describe("TestHost scripted shell", () => {
  const run = <A, E>(
    effect: Effect.Effect<A, E, Shell>,
    commands?: Readonly<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>
  ) => Effect.runPromise(Effect.provide(effect, TestHost.layer(commands === undefined ? {} : { commands })))

  it("reports an unlisted command the way a shell reports a missing binary", async () => {
    const result = await run(
      Effect.flatMap(Shell, (shell) => shell.exec("curl https://example.com"))
    )

    expect(result).toEqual({
      stdout: "",
      stderr: "command not found: curl https://example.com\n",
      exitCode: 127
    })
  })

  it("defaults every unscripted field of a declared command", async () => {
    const result = await run(Effect.flatMap(Shell, (shell) => shell.exec("noop")), { noop: {} })

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  it("streams stdout then stderr as one chunk each and omits empty ones", async () => {
    const collect = (command: string) =>
      Effect.flatMap(Shell, (shell) =>
        Stream.runCollect(shell.stream(command)).pipe(
          Effect.map((chunks) => Array.from(chunks).map((c) => ({ kind: c.kind, text: decoder.decode(c.chunk) })))
        ))

    const [both, onlyErr, silent] = await run(
      Effect.all([collect("both"), collect("only-err"), collect("silent")]),
      {
        both: { stdout: "out", stderr: "err", exitCode: 1 },
        "only-err": { stderr: "bad" },
        silent: {}
      }
    )

    expect(both).toEqual([{ kind: "stdout", text: "out" }, { kind: "stderr", text: "err" }])
    expect(onlyErr).toEqual([{ kind: "stderr", text: "bad" }])
    expect(silent).toEqual([])
  })

  it("fails with `shell_unavailable` when a caller supplies stdin", async () => {
    const error = await run(
      Effect.flatMap(Shell, (shell) => Effect.flip(shell.exec("cat", { stdin: "hello" })))
    )

    expect(error).toMatchObject({
      code: "shell_unavailable",
      command: "cat",
      message: "just-bash cannot supply stdin to a command"
    })
  })

  it("maps a thrown interpreter error onto `spawn_error`", async () => {
    const bash: JustBashShell.JustBashLike = {
      run: async () => {
        throw new Error("interpreter exploded")
      }
    }

    const error = await Effect.runPromise(
      Effect.flatMap(Shell, (shell) => Effect.flip(shell.exec("boom"))).pipe(
        Effect.provide(JustBashShell.layer(bash))
      )
    )

    expect(error).toMatchObject({ code: "spawn_error", message: "interpreter exploded", command: "boom" })
  })

  it("stringifies a non-Error interpreter rejection", async () => {
    const bash: JustBashShell.JustBashLike = {
      run: async () => {
        throw "not an error"
      }
    }

    const error = await Effect.runPromise(
      Effect.flatMap(Shell, (shell) => Effect.flip(shell.exec("boom"))).pipe(
        Effect.provide(JustBashShell.layer(bash))
      )
    )

    expect(error.message).toBe("not an error")
  })

  it("fails with `timeout` once the budget elapses, after the uninterruptible call settles", async () => {
    let settled = false
    const bash: JustBashShell.JustBashLike = {
      run: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true
            resolve({ stdout: "late", stderr: "", exitCode: 0 })
          }, 20)
        )
    }

    const error = await Effect.runPromise(
      Effect.flatMap(Shell, (shell) => Effect.flip(shell.exec("slow", { timeoutMs: 1 }))).pipe(
        Effect.provide(JustBashShell.layer(bash))
      )
    )

    expect(error).toMatchObject({ code: "timeout", command: "slow" })
    expect(error.message).toBe("command exceeded 1ms")
    expect(settled).toBe(true)
  })

  it("serializes concurrent commands through the single-permit gate", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const bash: JustBashShell.JustBashLike = {
      run: async (command) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
        return { stdout: command, stderr: "", exitCode: 0 }
      }
    }

    const results = await Effect.runPromise(
      Effect.flatMap(
        Shell,
        (shell) => Effect.all([shell.exec("a"), shell.exec("b"), shell.exec("c")], { concurrency: "unbounded" })
      ).pipe(
        Effect.provide(JustBashShell.layer(bash))
      )
    )

    expect(results.map((result) => result.stdout).sort()).toEqual(["a", "b", "c"])
    expect(maxInFlight).toBe(1)
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
        const shell = yield* Shell
        return {
          root: yield* fs.readDirectory("/"),
          exit: (yield* shell.exec("ls")).exitCode
        }
      }).pipe(Effect.provide(TestHost.TestHost))
    )

    expect(state).toEqual({ root: [], exit: 127 })
  })
})

describe("TestHost unsupported services", () => {
  it("fails `pty.spawn` with `unsupported` and names the requested command", async () => {
    const error = await Effect.runPromise(
      Effect.flatMap(Pty, (pty) => Effect.flip(Effect.scoped(pty.spawn("bash", { cols: 80, rows: 24 })))).pipe(
        Effect.provide(TestHost.TestHost)
      )
    )

    expect(error).toMatchObject({ code: "unsupported", message: "no pty in the browser (requested: bash)" })
  })

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

    expect(errors.map((error) => error.command)).toEqual([
      "jj commit",
      "jj edit",
      "jj diff",
      "jj workspace add",
      "jj workspace forget",
      "jj status"
    ])
    expect(new Set(errors.map((error) => error.code))).toEqual(new Set(["not_installed"]))
  })

  it("fails HTTP requests through the noop transport", async () => {
    const transport = HttpTransport.makeNoop()

    const error = await Effect.runPromise(
      Effect.flip(transport.execute({ url: "https://example.com" } as never))
    )

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

describe("TestHost scripted shell defaults", () => {
  it("reports the interpreter root as the working directory", () => {
    expect(TestHost.makeStubBash().getCwd?.()).toBe("/")
  })
})
