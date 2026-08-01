import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ShellError } from "../src/HostError.ts"
import * as RemoteSandbox from "../src/RemoteSandbox.ts"
import { Shell } from "../src/Shell.ts"

const encoder = new TextEncoder()

describe("RemoteSandbox", () => {
  it("adapts scripted exec through Shell", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      session: "exec-session",
      scripts: {
        greet: {
          result: { stdout: "hello", stderr: "", exitCode: 0 }
        }
      }
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell
        return yield* shell.exec("greet")
      }).pipe(Effect.provide(RemoteSandbox.layerShell(provider)))
    )

    expect(result).toEqual({ stdout: "hello", stderr: "", exitCode: 0 })
    expect(provider.state.openedSessions).toEqual(["exec-session"])
    expect(provider.state.commands).toEqual(["greet"])
  })

  it("adapts tagged output chunks through Shell streaming", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      scripts: {
        stream: {
          chunks: [
            { kind: "stdout", chunk: encoder.encode("out") },
            { kind: "stderr", chunk: encoder.encode("err") }
          ]
        }
      }
    })

    const chunks = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell
        return yield* shell.stream("stream").pipe(Stream.runCollect)
      }).pipe(Effect.provide(RemoteSandbox.layerShell(provider)))
    )

    expect(Array.from(chunks, (chunk) => chunk.kind)).toEqual(["stdout", "stderr"])
    expect(Array.from(chunks, (chunk) => new TextDecoder().decode(chunk.chunk))).toEqual(["out", "err"])
  })

  it("runs the provider cancellation finalizer on interruption", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      scripts: {
        pending: { pending: true }
      }
    })

    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.gen(function*() {
          const shell = yield* Shell
          yield* shell.exec("pending")
        }).pipe(
          Effect.provide(RemoteSandbox.layerShell(provider)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      })
    )

    expect(provider.state.cancellations).toBe(1)
  })

  it("maps typed provider failures onto the closed ShellError codes", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      scripts: {
        fail: {
          failure: new RemoteSandbox.ProviderError({
            code: "spawn_error",
            message: "provider rejected command"
          })
        }
      }
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell
        return yield* Effect.result(shell.exec("fail"))
      }).pipe(Effect.provide(RemoteSandbox.layerShell(provider)))
    )

    expect("failure" in result).toBe(true)
    if ("failure" in result) {
      expect(result.failure).toBeInstanceOf(ShellError)
      expect(result.failure.code).toBe("spawn_error")
      expect(result.failure.method).toBe("exec")
      expect(result.failure.command).toBe("fail")
    }
  })

  it("provides a failing Shell when opening the remote session fails", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      openFailure: new RemoteSandbox.ProviderError({
        code: "shell_unavailable",
        message: "provider session is unavailable"
      })
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell
        return yield* Effect.result(shell.exec("never-opened"))
      }).pipe(Effect.provide(RemoteSandbox.layerShell(provider)))
    )

    expect("failure" in result).toBe(true)
    if ("failure" in result) {
      expect(result.failure).toBeInstanceOf(ShellError)
      expect(result.failure.code).toBe("shell_unavailable")
      expect(result.failure.method).toBe("open")
    }
  })
})

describe("RemoteSandbox open failure", () => {
  const provider = () =>
    RemoteSandbox.TestSandbox.make({
      openFailure: new RemoteSandbox.ProviderError({
        code: "shell_unavailable",
        message: "provider session is unavailable"
      })
    })

  it("fails the stream with the open failure instead of hanging on an empty queue", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell
        return yield* Effect.flip(Stream.runCollect(shell.stream("never-opened")))
      }).pipe(Effect.provide(RemoteSandbox.layerShell(provider())))
    )

    expect(error).toBeInstanceOf(ShellError)
    expect(error.code).toBe("shell_unavailable")
    expect(error.method).toBe("open")
    expect(error.command).toBe("never-opened")
  })
})

describe("RemoteSandbox test double scripting", () => {
  it("answers an unscripted exec the way a shell reports a missing binary", async () => {
    const provider = RemoteSandbox.TestSandbox.make({ scripts: { other: {} } })

    const result = await Effect.runPromise(
      Effect.flatMap(Shell, (shell) => shell.exec("nope")).pipe(
        Effect.provide(RemoteSandbox.layerShell(provider))
      )
    )

    expect(result).toEqual({ stdout: "", stderr: "command not found: nope\n", exitCode: 127 })
    expect(provider.state.commands).toEqual(["nope"])
  })

  it("answers a scripted command with no declared result as an empty success", async () => {
    const provider = RemoteSandbox.TestSandbox.make({ scripts: { quiet: {} } })

    const result = await Effect.runPromise(
      Effect.flatMap(Shell, (shell) => shell.exec("quiet")).pipe(
        Effect.provide(RemoteSandbox.layerShell(provider))
      )
    )

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  it("fails a streamed command whose script declares a provider failure", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      scripts: {
        broken: {
          failure: new RemoteSandbox.ProviderError({ code: "spawn_error", message: "provider rejected stream" })
        }
      }
    })

    const error = await Effect.runPromise(
      Effect.flip(Stream.runCollect(Stream.unwrap(Effect.map(Shell, (shell) => shell.stream("broken"))))).pipe(
        Effect.provide(RemoteSandbox.layerShell(provider))
      )
    )

    expect(error).toBeInstanceOf(ShellError)
    expect(error.method).toBe("execStream")
    expect(error.message).toBe("provider rejected stream")
  })

  it("derives one stdout chunk from a script that only declares a buffered result", async () => {
    const provider = RemoteSandbox.TestSandbox.make({
      scripts: { echo: { result: { stdout: "derived", stderr: "", exitCode: 0 } } }
    })

    const chunks = await Effect.runPromise(
      Stream.runCollect(Stream.unwrap(Effect.map(Shell, (shell) => shell.stream("echo")))).pipe(
        Effect.provide(RemoteSandbox.layerShell(provider))
      )
    )

    expect(Array.from(chunks, (chunk) => [chunk.kind, new TextDecoder().decode(chunk.chunk)]))
      .toEqual([["stdout", "derived"]])
  })

  it("streams an empty stdout chunk for a script with neither chunks nor a result", async () => {
    const provider = RemoteSandbox.TestSandbox.make({ scripts: { silent: {} } })

    const chunks = await Effect.runPromise(
      Stream.runCollect(Stream.unwrap(Effect.map(Shell, (shell) => shell.stream("silent")))).pipe(
        Effect.provide(RemoteSandbox.layerShell(provider))
      )
    )

    expect(Array.from(chunks, (chunk) => new TextDecoder().decode(chunk.chunk))).toEqual([""])
  })

  it("runs the cancellation finalizer when a pending stream consumer is interrupted", async () => {
    const provider = RemoteSandbox.TestSandbox.make({ scripts: { pending: { pending: true } } })

    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Stream.runDrain(
          Stream.unwrap(Effect.map(Shell, (shell) => shell.stream("pending")))
        ).pipe(
          Effect.provide(RemoteSandbox.layerShell(provider)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      })
    )

    expect(provider.state.commands).toEqual(["pending"])
    expect(provider.state.cancellations).toBe(1)
  })
})
