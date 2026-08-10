import type { JjError } from "@smthrs/jj"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Jj from "../src/Jj.ts"
import * as Pty from "../src/Pty.ts"
import * as Shell from "../src/Shell.ts"

/**
 * The kernel stubs exist so a program can be wired without a host at all: an
 * unconfigured capability must answer, not vanish. Each stub inherits the Host
 * noop implementation, so the failure a caller sees is the host's "no such
 * capability here" error rather than a permission decision.
 */
describe("kernel stubs without any host", () => {
  it("denies shell exec and stream with `shell_unavailable`", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell.Shell
        const exec = yield* Effect.flip(shell.exec("ls"))
        const streamed = yield* Effect.flip(Stream.runCollect(shell.stream("ls")))
        return { exec, streamed }
      }).pipe(Effect.provide(Shell.layerNoop()))
    )

    expect(result.exec).toMatchObject({ code: "shell_unavailable", method: "exec", command: "ls" })
    expect(result.streamed).toMatchObject({ code: "shell_unavailable", method: "stream", command: "ls" })
  })

  it("denies pty spawn with `unsupported`", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const pty = yield* Pty.Pty
        return yield* Effect.flip(Effect.scoped(pty.spawn("bash", { cols: 80, rows: 24 })))
      }).pipe(Effect.provide(Pty.layerNoop()))
    )

    expect(error).toMatchObject({ code: "unsupported", method: "spawn" })
  })

  it("denies every jj operation with `not_installed`", async () => {
    const jj = Jj.makeNoop()
    const errors = await Effect.runPromise(
      Effect.all([
        Effect.flip(jj.snapshot("m")),
        Effect.flip(jj.restore("abc")),
        Effect.flip(jj.diff("a", "b")),
        Effect.flip(jj.workspaceAdd("lane", "/tmp/lane")),
        Effect.flip(jj.workspaceForget("lane")),
        Effect.flip(jj.status())
      ])
    )

    expect(errors.map((error) => (error as JjError).code)).toEqual(Array.from({ length: 6 }, () => "not_installed"))
    expect(errors.map((error) => (error as JjError).method)).toEqual([
      "snapshot",
      "restore",
      "diff",
      "workspaceAdd",
      "workspaceForget",
      "status"
    ])
  })

  it("lets overrides replace individual methods while the rest stay denied", async () => {
    const shell = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell.Shell
        const ok = yield* shell.exec("echo hi")
        const denied = yield* Effect.flip(Stream.runCollect(shell.stream("echo hi")))
        return { ok, denied }
      }).pipe(
        Effect.provide(
          Shell.layerNoop({ exec: () => Effect.succeed({ stdout: "hi", stderr: "", exitCode: 0 }) })
        )
      )
    )
    const jj = Jj.make(Jj.makeNoop({ status: () => Effect.succeed("clean") }))

    expect(shell.ok).toEqual({ stdout: "hi", stderr: "", exitCode: 0 })
    expect(shell.denied).toMatchObject({ code: "shell_unavailable" })
    await expect(Effect.runPromise(jj.status())).resolves.toBe("clean")
    await expect(Effect.runPromise(Effect.flip(jj.snapshot()))).resolves.toMatchObject({ code: "not_installed" })
  })

  it("returns the implementation unchanged from `make`", () => {
    const pty = Pty.makeNoop()
    expect(Pty.make(pty)).toStrictEqual(pty)
    const shell = Shell.makeNoop()
    expect(Shell.make(shell)).toStrictEqual(shell)
  })
})
