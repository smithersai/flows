import { Effect, Fiber, PlatformError, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"

const reason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("RemoteChildProcessSpawner", () => {
  it("adapts a scripted command through the spawner's buffered helper", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      session: "exec-session",
      scripts: { greet: { stdout: "hello" } }
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const command = ChildProcess.make("greet")
        return {
          stdout: yield* spawner.string(command),
          exitCode: yield* spawner.exitCode(command)
        }
      }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(result).toEqual({ stdout: "hello", exitCode: 0 })
    expect(provider.state.openedSessions).toEqual(["exec-session"])
    expect(provider.state.commands).toEqual(["greet", "greet"])
  })

  it("renders arguments and a pipeline into the command the provider receives", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      scripts: { "printf 'a b' | grep a": { stdout: "a b" } }
    })

    const output = await Effect.runPromise(
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) =>
          spawner.string(
            ChildProcess.make("printf", ["a b"]).pipe(ChildProcess.pipeTo(ChildProcess.make("grep", ["a"])))
          )
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(output).toBe("a b")
    expect(provider.state.commands).toEqual(["printf 'a b' | grep a"])
  })

  it("renders shell commands under the exact unquoted line the provider executes", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      scripts: { "echo safe; run privileged": { stdout: "done" } }
    })

    const output = await Effect.runPromise(
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.string(ChildProcess.make("echo", ["safe;", "run", "privileged"], { shell: true }))
      ).pipe(
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )
    )

    expect(output).toBe("done")
    expect(provider.state.commands).toEqual(["echo safe; run privileged"])
  })

  it("interleaves stdout and stderr through the handle's `all` stream", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      scripts: { noisy: { stdout: "out", stderr: "err" } }
    })

    const output = await Effect.runPromise(
      Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => Stream.runCollect(spawner.streamString(ChildProcess.make("noisy"), { includeStderr: true }))
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(Array.from(output).sort()).toEqual(["err", "out"])
  })

  it("runs the provider cancellation finalizer on interruption", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { pending: { pending: true } } })

    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.flatMap(
          ChildProcessSpawner,
          (spawner) => spawner.exitCode(ChildProcess.make("pending"))
        ).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      })
    )

    expect(provider.state.commands).toEqual(["pending"])
    expect(provider.state.cancellations).toBe(1)
  })

  it("maps typed provider failures onto normalized PlatformError reasons", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      scripts: {
        fail: {
          failure: new RemoteChildProcessSpawner.ProviderError({
            code: "spawn_error",
            message: "provider rejected command"
          })
        },
        slow: {
          failure: new RemoteChildProcessSpawner.ProviderError({ code: "timeout", message: "provider gave up" })
        }
      }
    })

    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return [
          yield* Effect.flip(spawner.string(ChildProcess.make("fail"))),
          yield* Effect.flip(spawner.string(ChildProcess.make("slow")))
        ]
      }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(errors.map(reason)).toEqual(["Unknown", "TimedOut"])
    expect(errors[0]?.message).toContain("`fail`: provider rejected command")
  })

  it("provides a spawner that fails every command when opening the session fails", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      openFailure: new RemoteChildProcessSpawner.ProviderError({
        code: "unavailable",
        message: "provider session is unavailable"
      })
    })

    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return [
          yield* Effect.flip(spawner.string(ChildProcess.make("never-opened"))),
          // A stream must fail too, not hang on a queue nothing will ever end.
          yield* Effect.flip(Stream.runDrain(spawner.streamString(ChildProcess.make("never-opened"))))
        ]
      }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(errors.map(reason)).toEqual(["NotFound", "NotFound"])
    expect(errors[0]?.message).toContain("`never-opened`: provider session is unavailable")
  })

  it("answers an unconfigured extra file descriptor the way a local spawner does", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: { stdout: "out" } } })

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("quiet"))
        return {
          // A descriptor nobody configured drains on the way in and is empty on
          // the way out — the same answer `NodeChildProcessSpawner` gives.
          written: yield* Stream.run(Stream.fromArray([new Uint8Array([1])]), handle.getInputFd(3)),
          read: yield* Stream.runCollect(handle.getOutputFd(3))
        }
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(observed.written).toBeUndefined()
    expect(Array.from(observed.read)).toEqual([])
  })

  it("rejects stdin and kill instead of dropping them silently", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("quiet"))
        return [
          yield* Effect.flip(Stream.run(Stream.fromArray([new Uint8Array([1])]), handle.stdin)),
          yield* Effect.flip(handle.kill())
        ]
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(errors.map(reason)).toEqual(["BadArgument", "BadArgument"])
  })

  it("rejects command-supplied stdin before the provider starts", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.exitCode(ChildProcess.make("quiet", [], {
            stdin: Stream.fromArray([new Uint8Array([1])])
          })))
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(reason(error)).toBe("BadArgument")
    expect(error.message).toContain("cannot supply stdin")
    expect(provider.state.commands).toEqual([])
  })

  it("rejects command-supplied stdin inside a config", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(ChildProcessSpawner, (spawner) =>
          spawner.exitCode(ChildProcess.make("quiet", [], {
            stdin: { stream: Stream.fromArray([new Uint8Array([1])]) }
          })))
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(reason(error)).toBe("BadArgument")
    expect(provider.state.commands).toEqual([])
  })

  it.each([
    [
      "a non-default pipe source",
      ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"), { from: "stderr" }),
      "pipe from stderr"
    ],
    [
      "a non-default pipe destination",
      ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"), { to: "fd3" }),
      "pipe to fd3"
    ],
    [
      "additional file descriptors",
      ChildProcess.make("quiet", [], { additionalFds: { fd3: { type: "output" } } }),
      "additional file descriptors"
    ],
    ["a custom shell", ChildProcess.make("quiet", [], { shell: "/bin/zsh" }), "requested shell"],
    ["a detached process", ChildProcess.make("quiet", [], { detached: true }), "detach"]
  ])("rejects %s instead of changing its meaning", async (_name, command, message) => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({})

    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(command))).pipe(
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )
    )

    expect(reason(error)).toBe("BadArgument")
    expect(error.message).toContain(message)
    expect(provider.state.commands).toEqual([])
  })

  it("honors output dispositions and sinks", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      scripts: { noisy: { stdout: "out", stderr: "err" } }
    })
    const upper = Sink.map(
      Sink.collect<Uint8Array>(),
      (chunks) =>
        new TextEncoder().encode(
          chunks.map((chunk) => new TextDecoder().decode(chunk)).join("").toUpperCase()
        )
    )

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("noisy", [], {
          stdout: upper,
          stderr: { stream: "ignore" }
        }))
        return {
          stdout: yield* Stream.mkString(Stream.decodeText(handle.stdout)),
          stderr: yield* Stream.mkString(Stream.decodeText(handle.stderr))
        }
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(observed).toEqual({ stdout: "OUT", stderr: "" })
  })

  it.each([
    [undefined, "out"],
    ["pipe" as const, "out"],
    ["overlapped" as const, "out"],
    ["ignore" as const, ""],
    ["inherit" as const, ""]
  ])("honors the %s stdout disposition", async (stdout, expected) => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { noisy: { stdout: "out" } } })

    const observed = await Effect.runPromise(
      Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(ChildProcess.make("noisy", [], { stdout }))).pipe(
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )
    )

    expect(observed).toBe(expected)
  })

  it("accepts explicit default pipeline routing and empty option objects", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({
      scripts: { "left | right": { stdout: "ok" } }
    })
    const command = ChildProcess.pipeTo(
      ChildProcess.make("left", [], { additionalFds: {}, stdin: "pipe" }),
      ChildProcess.make("right", [], { stdout: {}, stderr: {} }),
      { from: "stdout", to: "stdin" }
    )

    const output = await Effect.runPromise(
      Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command)).pipe(
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )
    )

    expect(output).toBe("ok")
  })
})

describe("RemoteChildProcessSpawner test double scripting", () => {
  it("answers an unscripted command the way a shell reports a missing binary", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { other: {} } })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const command = ChildProcess.make("nope")
        return {
          stderr: yield* Stream.mkString(spawner.streamString(command, { includeStderr: true })),
          exitCode: yield* spawner.exitCode(command)
        }
      }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(result).toEqual({ stderr: "command not found: nope\n", exitCode: 127 })
  })

  it("answers a scripted command with no declared output as an empty success", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: {} } })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const command = ChildProcess.make("quiet")
        return {
          stdout: yield* spawner.string(command),
          exitCode: yield* spawner.exitCode(command)
        }
      }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(result).toEqual({ stdout: "", exitCode: 0 })
  })

  it("reports the process as running until its exit code arrives", async () => {
    const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { quiet: { exitCode: 3 } } })

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("quiet"))
        const before = yield* handle.isRunning
        const exitCode = yield* handle.exitCode
        return { before, exitCode, after: yield* handle.isRunning }
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))
    )

    expect(observed).toEqual({ before: true, exitCode: 3, after: false })
  })
})
