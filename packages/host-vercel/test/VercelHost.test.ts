import { Jj } from "@flows/host/Jj"
import { Pty } from "@flows/host/Pty"
import { Shell } from "@flows/host/Shell"
import { Cause, Effect, FileSystem, Option, Path } from "effect"
import { describe, expect, it } from "vitest"
import * as VercelHost from "../src/VercelHost.ts"

const storage: VercelHost.Options["storage"] = {
  kv: {
    get: async () => null,
    set: async () => {},
    del: async () => {},
    scan: async () => []
  }
}

describe("VercelHost", () => {
  it("provides all six closed host services", async () => {
    const program = Effect.gen(function*() {
      yield* FileSystem.FileSystem
      yield* Path.Path
      yield* Shell
      yield* Pty
      yield* Jj
      return true
    })
    await expect(Effect.runPromise(Effect.provide(program, VercelHost.layer({ storage })))).resolves.toBe(true)
  })

  it("keeps unsupported edge capabilities typed", async () => {
    const shell = Effect.runPromiseExit(Effect.provide(
      Effect.gen(function*() {
        return yield* (yield* Shell).exec("echo hi")
      }),
      VercelHost.layer({ storage })
    ))
    const pty = Effect.runPromiseExit(Effect.provide(
      Effect.gen(function*() {
        return yield* (yield* Pty).spawn("sh", { cols: 80, rows: 24 })
      }),
      VercelHost.layer({ storage })
    ))
    const jj = Effect.runPromiseExit(Effect.provide(
      Effect.gen(function*() {
        return yield* (yield* Jj).status()
      }),
      VercelHost.layer({ storage })
    ))
    const shellExit = await shell
    const ptyExit = await pty
    const jjExit = await jj
    if (shellExit._tag !== "Failure" || ptyExit._tag !== "Failure" || jjExit._tag !== "Failure") {
      throw new Error("expected typed failures")
    }
    expect(Option.getOrThrow(Cause.findErrorOption(shellExit.cause)).code).toBe("shell_unavailable")
    expect(Option.getOrThrow(Cause.findErrorOption(ptyExit.cause)).code).toBe("unsupported")
    expect(Option.getOrThrow(Cause.findErrorOption(jjExit.cause)).code).toBe("not_installed")
  })
})
