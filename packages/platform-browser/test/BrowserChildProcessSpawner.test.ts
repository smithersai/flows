/**
 * The spawner is driven through a stub `JustBashLike`, because what is being
 * pinned is the adapter — which command line the interpreter is handed, which
 * `PlatformError` a missing capability produces, and the serialized
 * uninterruptible boundary — not just-bash's own parser.
 *
 * `FileSystem` comes from this package's own `BrowserFileSystem` over
 * `node:fs/promises`, so the `cwd` validation path is exercised against a real
 * directory rather than a double.
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Deferred, Effect, Exit, Fiber, Layer, Path, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtemp, rm } from "node:fs/promises"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as BrowserChildProcessSpawner from "../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"

interface Call {
  readonly command: string
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
}

interface Stub {
  readonly bash: BrowserChildProcessSpawner.JustBashLike
  readonly calls: Array<Call>
}

const stub = (
  run: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): Stub => {
  const calls: Array<Call> = []
  return {
    calls,
    bash: {
      run: (command, opts) => {
        calls.push({ command, cwd: opts?.cwd, env: opts?.env })
        return run(command)
      }
    }
  }
}

const ok = (stdout = "", stderr = "", exitCode = 0) => async () => ({ stdout, stderr, exitCode })

const join = (...segments: ReadonlyArray<string>): string => segments.join("/")

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-platform-browser-spawn-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const layerOf = (bash: BrowserChildProcessSpawner.JustBashLike) =>
  BrowserChildProcessSpawner.layer(bash).pipe(
    Layer.provide(Layer.mergeAll(BrowserFileSystem.layer(NodeFsPromises), Path.layer))
  )

const run = <A, E>(
  bash: BrowserChildProcessSpawner.JustBashLike,
  effect: Effect.Effect<A, E, ChildProcessSpawner>
): Promise<A> => Effect.runPromise(Effect.provide(effect, layerOf(bash)))

const runExit = <A, E>(
  bash: BrowserChildProcessSpawner.JustBashLike,
  effect: Effect.Effect<A, E, ChildProcessSpawner>
) => Effect.runPromiseExit(Effect.provide(effect, layerOf(bash)))

describe("BrowserChildProcessSpawner", () => {
  it("renders the line with the very renderer the kernel grants against", async () => {
    const { bash, calls } = stub(ok("hi\n"))

    const command = ChildProcess.make("echo", ["a b", "it's"])
    const output = await run(
      bash,
      Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command))
    )

    expect(output).toBe("hi\n")
    // Argv semantics are kept by quoting only what needs it — and the string is
    // `CommandLine.render`'s, the same one `proc:spawn` is checked against, so
    // a grant cannot authorize a line different from the one that runs.
    expect(calls[0]?.command).toBe("echo 'a b' 'it'\\''s'")
    expect(calls[0]?.command).toBe(CommandLine.render(command))
  })

  it("passes the line through verbatim when `shell` is requested", async () => {
    const { bash, calls } = stub(ok())

    await run(
      bash,
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make("ls | wc -l", [], { shell: true }))
      )
    )

    expect(calls[0]?.command).toBe("ls | wc -l")
  })

  it("reports the interpreter exit code and both captured streams", async () => {
    const { bash } = stub(ok("out", "err", 3))

    const result = await run(
      bash,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("thing"))
        const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
        const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr))
        const all = yield* Stream.mkString(Stream.decodeText(handle.all))
        return { code: yield* handle.exitCode, stdout, stderr, all, running: yield* handle.isRunning }
      }))
    )

    expect(result).toEqual({ code: 3, stdout: "out", stderr: "err", all: "outerr", running: false })
  })

  it("emits no chunk at all for an empty stream", async () => {
    const { bash } = stub(ok("", "only-stderr"))

    const chunks = await run(
      bash,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("thing"))
        return yield* Stream.runCollect(handle.stdout)
      }))
    )

    expect(Array.from(chunks)).toEqual([])
  })

  /**
   * The interpreter captures the text either way, so the dispositions have to
   * be applied by the adapter — Node gets them for free by never opening a
   * readable for anything but `"pipe"`.
   */
  it.each([
    ["ignore" as const, ""],
    ["inherit" as const, ""],
    ["pipe" as const, "out"],
    ["overlapped" as const, "out"]
  ])("honours the `%s` stdout disposition", async (disposition, expected) => {
    const { bash } = stub(ok("out", "err"))

    const observed = await run(
      bash,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("thing", [], { stdout: disposition }))
        return yield* Stream.mkString(Stream.decodeText(handle.stdout))
      }))
    )

    expect(observed).toBe(expected)
  })

  it("honours a disposition nested in a stdout config, and an undefined one inside it", async () => {
    const { bash } = stub(ok("out", "err"))

    const observed = await run(
      bash,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const ignored = yield* spawner.spawn(ChildProcess.make("thing", [], { stderr: { stream: "ignore" } }))
        const piped = yield* spawner.spawn(ChildProcess.make("thing", [], { stderr: {} }))
        return {
          ignored: yield* Stream.mkString(Stream.decodeText(ignored.stderr)),
          piped: yield* Stream.mkString(Stream.decodeText(piped.stderr))
        }
      }))
    )

    expect(observed).toEqual({ ignored: "", piped: "err" })
  })

  it("transduces captured output through a `Sink` given as a disposition", async () => {
    const { bash } = stub(ok("out"))
    const upper = Sink.map(
      Sink.collect<Uint8Array>(),
      (chunks) =>
        new TextEncoder().encode(chunks.map((chunk) => new TextDecoder().decode(chunk)).join("").toUpperCase())
    )

    const observed = await run(
      bash,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("thing", [], { stdout: upper }))
        return yield* Stream.mkString(Stream.decodeText(handle.stdout))
      }))
    )

    expect(observed).toBe("OUT")
  })

  it("forwards cwd and env, dropping the undefined values just-bash cannot represent", async () => {
    const { bash, calls } = stub(ok())

    await run(
      bash,
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.exitCode(ChildProcess.make("thing", [], {
          cwd: root,
          env: { KEEP: "yes", DROP: undefined },
          extendEnv: true
        })))
    )

    expect(calls[0]?.cwd).toBe(root)
    expect(calls[0]?.env).toEqual({ KEEP: "yes" })
  })

  it("omits cwd and env entirely when the command declares neither", async () => {
    const { bash, calls } = stub(ok())

    await run(bash, Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))

    expect(calls[0]).toEqual({ command: "thing", cwd: undefined, env: undefined })
  })

  it("fails before running anything when cwd does not exist", async () => {
    const { bash, calls } = stub(ok())

    const exit = await runExit(
      bash,
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { cwd: join(root, "absent") }))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toEqual([])
  })

  it("wraps a thrown interpreter failure as a system PlatformError", async () => {
    const { bash } = stub(async () => {
      throw new Error("interpreter exploded")
    })

    const error = await run(
      bash,
      Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))
    )

    expect(error.reason).toMatchObject({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "spawn",
      description: "interpreter exploded"
    })
  })

  it("stringifies a non-Error interpreter rejection", async () => {
    const { bash } = stub(async () => {
      throw "plain"
    })

    const error = await run(
      bash,
      Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("thing"))))
    )

    expect(error.reason.description).toBe("plain")
  })
})

describe("BrowserChildProcessSpawner rejected inputs", () => {
  it("rejects a pipeline of processes rather than pretending to fork", async () => {
    const { bash, calls } = stub(ok())

    const error = await run(
      bash,
      Effect.flip(
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.pipeTo(ChildProcess.make("a"), ChildProcess.make("b")))
        )
      )
    )

    expect(error.reason).toMatchObject({ _tag: "BadArgument", module: "ChildProcess", method: "spawn" })
    expect(error.message).toContain("single command line")
    expect(calls).toEqual([])
  })

  it("rejects stdin given directly as a stream", async () => {
    const { bash } = stub(ok())

    const error = await run(
      bash,
      Effect.flip(
        Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { stdin: Stream.make(new Uint8Array([1])) }))
        )
      )
    )

    expect(error.message).toContain("cannot supply stdin")
  })

  it("rejects stdin given as a config wrapping a stream", async () => {
    const { bash } = stub(ok())

    const error = await run(
      bash,
      Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) =>
        spawner.exitCode(
          ChildProcess.make("thing", [], { stdin: { stream: Stream.make(new Uint8Array([1])) } })
        )))
    )

    expect(error.reason._tag).toBe("BadArgument")
  })

  it("accepts the string stdin dispositions, which name a pipe rather than supply one", async () => {
    const { bash, calls } = stub(ok())

    await run(
      bash,
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { stdin: "ignore" }))
      )
    )

    expect(calls).toHaveLength(1)
  })

  it("accepts a stdin config that names a disposition instead of a stream", async () => {
    const { bash, calls } = stub(ok())

    await run(
      bash,
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make("thing", [], { stdin: { stream: "inherit" } }))
      )
    )

    expect(calls).toHaveLength(1)
  })
})

describe("BrowserChildProcessSpawner handle capabilities", () => {
  it("hands out increasing pids, a failing stdin, a failing kill, and a no-op unref", async () => {
    const { bash } = stub(ok())

    const observed = await run(
      bash,
      Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const first = yield* spawner.spawn(ChildProcess.make("one"))
        const second = yield* spawner.spawn(ChildProcess.make("two"))
        const stdin = yield* Effect.flip(Stream.run(Stream.make(new Uint8Array([1])), second.stdin))
        const kill = yield* Effect.flip(second.kill())
        const reref = yield* second.unref
        yield* reref
        const fd = yield* Stream.runCollect(second.getOutputFd(3))
        yield* Stream.run(Stream.make(new Uint8Array([1])), second.getInputFd(3))
        return { pids: [first.pid, second.pid], stdin, kill, fd: Array.from(fd) }
      }))
    )

    expect(observed.pids).toEqual([1, 2])
    expect(observed.stdin.reason).toMatchObject({ method: "stdin", _tag: "Unknown" })
    expect(observed.kill.reason).toMatchObject({ method: "kill", _tag: "Unknown" })
    expect(observed.fd).toEqual([])
  })
})

describe("BrowserChildProcessSpawner boundary", () => {
  /**
   * just-bash cannot abort an in-flight call, so the adapter runs it
   * uninterruptibly. Both of these pin the same property from the two
   * directions a caller can approach it: the interpreter always finishes, and
   * the caller only hears about it afterwards.
   */
  it("waits for the interpreter before reporting an interruption", async () => {
    let finished = false
    const started = Deferred.makeUnsafe<void>()
    const { bash } = stub(async () => {
      Deferred.doneUnsafe(started, Exit.void)
      await new Promise((resolve) => setTimeout(resolve, 25))
      finished = true
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const fiber = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("slow")), {
            startImmediately: true
          })
          yield* Deferred.await(started)
          return yield* Fiber.interrupt(fiber)
        }),
        layerOf(bash)
      )
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(finished).toBe(true)
  })

  it("waits for the interpreter before reporting a timeout", async () => {
    let finished = false
    const { bash } = stub(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      finished = true
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    const exit = await runExit(
      bash,
      Effect.flatMap(ChildProcessSpawner, (spawner) => Effect.timeout(spawner.exitCode(ChildProcess.make("slow")), 1))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(finished).toBe(true)
  })

  it("serializes concurrent runs so one interpreter call never overlaps another", async () => {
    let inFlight = 0
    let overlapped = false
    const { bash } = stub(async () => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    await run(
      bash,
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        Effect.all(
          [
            spawner.exitCode(ChildProcess.make("a")),
            spawner.exitCode(ChildProcess.make("b")),
            spawner.exitCode(ChildProcess.make("c"))
          ],
          { concurrency: "unbounded" }
        ))
    )

    expect(overlapped).toBe(false)
  })

  it("derives `lines` and `streamLines` from the same buffered output", async () => {
    const { bash } = stub(ok("one\ntwo\n", "three\n"))

    const [lines, withStderr] = await run(
      bash,
      Effect.flatMap(ChildProcessSpawner, (spawner) =>
        Effect.all([
          spawner.lines(ChildProcess.make("thing")),
          spawner.lines(ChildProcess.make("thing"), { includeStderr: true })
        ]))
    )

    expect(Array.from(lines)).toEqual(["one", "two"])
    expect(Array.from(withStderr)).toEqual(["one", "two", "three"])
  })
})
