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
