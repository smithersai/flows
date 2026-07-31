import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as HostError from "../src/HostError.ts"
import * as Jj from "../src/Jj.ts"
import * as Pty from "../src/Pty.ts"
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

  it("builds pty errors with the Pty module default", () => {
    const error = HostError.ptyError({
      code: "exited",
      method: "spawn",
      description: "child died",
      exitCode: 3
    })

    expect(error._tag).toBe("flows/host/PtyError")
    expect(error.module).toBe("Pty")
    expect(error.message).toBe("exited: Pty.spawn: child died")
    expect(error.exitCode).toBe(3)
    expect(HostError.ptyError({ code: "not_found", module: "NodePty", method: "resize" }).message)
      .toBe("not_found: NodePty.resize")
  })

  it("builds jj errors with the Jj module default and carries the command", () => {
    const error = HostError.jjError({
      code: "conflict",
      method: "restore",
      description: "working copy conflicted",
      command: "jj restore --from abc"
    })

    expect(error._tag).toBe("flows/host/JjError")
    expect(error.module).toBe("Jj")
    expect(error.message).toBe("conflict: Jj.restore: working copy conflicted")
    expect(error.command).toBe("jj restore --from abc")
    expect(HostError.jjError({ code: "invalid_ref", module: "NodeJj", method: "diff" }).command)
      .toBeUndefined()
  })
})

describe("Shell facade", () => {
  it("derives `stream` from `exec` when the platform cannot stream", async () => {
    const shell = Shell.make({
      exec: () => Effect.succeed({ stdout: "out", stderr: "err", exitCode: 0 })
    })

    const chunks = await Effect.runPromise(Stream.runCollect(shell.stream("anything")))
    const decoder = new TextDecoder()

    expect(Array.from(chunks).map((chunk) => ({
      kind: chunk.kind,
      text: decoder.decode(chunk.chunk)
    }))).toEqual([
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

describe("Pty facade", () => {
  it("fails `spawn` with `unsupported` on platforms without a terminal", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const pty = yield* Pty.Pty
        return yield* Effect.flip(Effect.scoped(pty.spawn("bash", { cols: 80, rows: 24 })))
      }).pipe(Effect.provide(Pty.layerNoop({})))
    )

    expect(error).toMatchObject({
      code: "unsupported",
      module: "Pty",
      method: "spawn",
      message: "unsupported: Pty.spawn: no pseudo-terminal in this environment"
    })
  })

  it("uses an override when the platform does supply a terminal", async () => {
    const handle = { write: () => Effect.void } as unknown as Pty.PtyHandle
    const pty = Pty.make(Pty.makeNoop({ spawn: () => Effect.succeed(handle) }))

    await expect(Effect.runPromise(Effect.scoped(pty.spawn("bash", { cols: 1, rows: 1 }))))
      .resolves.toBe(handle)
  })
})

describe("Jj facade", () => {
  it("fails every method with `not_installed` naming the method that was called", async () => {
    const jj = Jj.makeNoop({})
    const calls: ReadonlyArray<readonly [string, Effect.Effect<unknown, HostError.JjError>]> = [
      ["snapshot", jj.snapshot("msg")],
      ["restore", jj.restore("abc")],
      ["diff", jj.diff("a", "b")],
      ["workspaceAdd", jj.workspaceAdd("lane", "/tmp/lane")],
      ["workspaceForget", jj.workspaceForget("lane")],
      ["status", jj.status()]
    ]

    for (const [method, effect] of calls) {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error).toMatchObject({
        code: "not_installed",
        module: "Jj",
        method,
        message: `not_installed: Jj.${method}: jj is not available on this host`
      })
    }
  })

  it("provides overrides through `layerNoop` while other methods stay unavailable", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const jj = yield* Jj.Jj
        const snapshot = yield* jj.snapshot()
        const failed = yield* Effect.flip(jj.status())
        return { snapshot, failed }
      }).pipe(Effect.provide(Jj.layerNoop({ snapshot: () => Effect.succeed({ changeId: "zzz" }) })))
    )

    expect(result.snapshot.changeId).toBe("zzz")
    expect(result.failed).toMatchObject({ code: "not_installed", method: "status" })
  })
})
