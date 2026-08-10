import type { JjError } from "@smthrs/jj"
import { Effect, PlatformError, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { describe, expect, it } from "vitest"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as Jj from "../src/Jj.ts"
import * as Pty from "../src/Pty.ts"

/**
 * The kernel stubs exist so a program can be wired without a host at all: an
 * unconfigured capability must answer, not vanish. Each stub inherits the Host
 * noop implementation, so the failure a caller sees is the host's "no such
 * capability here" error rather than a permission decision.
 */
describe("kernel stubs without any host", () => {
  it("denies every derived spawner helper with a `NotFound` PlatformError naming the command", async () => {
    const command = ChildProcess.make("ls", ["-al"])
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return {
          string: yield* Effect.flip(spawner.string(command)),
          exitCode: yield* Effect.flip(spawner.exitCode(command)),
          streamed: yield* Effect.flip(Stream.runDrain(spawner.streamLines(command)))
        }
      }).pipe(Effect.provide(ChildProcessSpawner.layerNoop()))
    )

    for (const error of Object.values(result)) {
      expect(error).toBeInstanceOf(PlatformError.PlatformError)
      expect((error as PlatformError.PlatformError).reason._tag).toBe("NotFound")
      expect(error.message).toContain("no process host for `ls -al`")
    }
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
    const command = ChildProcess.make("echo", ["hi"])
    const spawner = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return {
          ok: yield* spawner.string(command),
          denied: yield* Effect.flip(spawner.exitCode(command))
        }
      }).pipe(
        Effect.provide(ChildProcessSpawner.layerNoop({ string: () => Effect.succeed("hi") }))
      )
    )
    const jj = Jj.make(Jj.makeNoop({ status: () => Effect.succeed("clean") }))

    expect(spawner.ok).toBe("hi")
    expect((spawner.denied as PlatformError.PlatformError).reason._tag).toBe("NotFound")
    await expect(Effect.runPromise(jj.status())).resolves.toBe("clean")
    await expect(Effect.runPromise(Effect.flip(jj.snapshot()))).resolves.toMatchObject({ code: "not_installed" })
  })

  it("returns the implementation unchanged from `make`", () => {
    const pty = Pty.makeNoop()
    expect(Pty.make(pty)).toStrictEqual(pty)
    const spawner = ChildProcessSpawner.makeNoop()
    expect(ChildProcessSpawner.make(spawner)).toStrictEqual(spawner)
  })
})
