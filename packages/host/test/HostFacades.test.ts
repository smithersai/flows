import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as HostError from "../src/HostError.ts"
import * as Shell from "../src/Shell.ts"

describe("HostError constructors", () => {
  it("formats operation data as `code: module.method: description`", () => {
    const error = HostError.shellError({
      code: "timeout",
      method: "exec",
      description: "budget exceeded",
      command: "sleep 5",
      exitCode: 124
    })

    expect(error._tag).toBe("flows/host/ShellError")
    expect(error.code).toBe("timeout")
    expect(error.module).toBe("Shell")
    expect(error.method).toBe("exec")
    expect(error.message).toBe("timeout: Shell.exec: budget exceeded")
    expect(error.command).toBe("sleep 5")
    expect(error.exitCode).toBe(124)
  })

  it("omits the description clause when none is given and honors a module override", () => {
    const error = HostError.shellError({ code: "spawn_error", module: "BunShell", method: "stream" })

    expect(error.message).toBe("spawn_error: BunShell.stream")
    expect(error.command).toBeUndefined()
    expect(error.exitCode).toBeUndefined()
  })
})

describe("Shell facade", () => {
  it("derives `stream` from `exec` when the platform cannot stream", async () => {
    const shell = Shell.make({
      exec: () => Effect.succeed({ stdout: "out", stderr: "err", exitCode: 0 })
    })

    const chunks = await Effect.runPromise(Stream.runCollect(shell.stream("anything")))
    const decoder = new TextDecoder()

    expect(
      Array.from(chunks).map((chunk) => ({
        kind: chunk.kind,
        text: decoder.decode(chunk.chunk)
      }))
    ).toEqual([
      { kind: "stdout", text: "out" },
      { kind: "stderr", text: "err" }
    ])
  })

  it("keeps a platform-provided `stream` instead of deriving one", async () => {
    let execCalls = 0
    const shell = Shell.make({
      exec: () =>
        Effect.sync(() => {
          execCalls += 1
          return { stdout: "", stderr: "", exitCode: 0 }
        }),
      stream: () => Stream.make({ kind: "stdout", chunk: new TextEncoder().encode("live") } as const)
    })

    const chunks = await Effect.runPromise(Stream.runCollect(shell.stream("anything")))

    expect(execCalls).toBe(0)
    expect(new TextDecoder().decode(Array.from(chunks)[0]!.chunk)).toBe("live")
  })

  it("fails both methods with `shell_unavailable` and echoes the command", async () => {
    const shell = Shell.makeNoop({})

    const execError = await Effect.runPromise(Effect.flip(shell.exec("ls -al")))
    const streamError = await Effect.runPromise(Effect.flip(Stream.runCollect(shell.stream("ls -al"))))

    expect(execError).toMatchObject({
      code: "shell_unavailable",
      method: "exec",
      command: "ls -al",
      message: "shell_unavailable: Shell.exec: no shell in this environment"
    })
    expect(streamError).toMatchObject({ code: "shell_unavailable", method: "stream", command: "ls -al" })
  })

  it("lets an override replace one method while the other stays stubbed", async () => {
    const layer = Shell.layerNoop({
      exec: () => Effect.succeed({ stdout: "ok", stderr: "", exitCode: 0 })
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell.Shell
        const ok = yield* shell.exec("echo ok")
        const failed = yield* Effect.flip(Stream.runCollect(shell.stream("echo ok")))
        return { ok, failed }
      }).pipe(Effect.provide(layer))
    )

    expect(result.ok.stdout).toBe("ok")
    expect(result.failed).toMatchObject({ code: "shell_unavailable" })
  })
})
