import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Pty from "../src/Pty.ts"

describe("ptyError", () => {
  it("builds pty errors with the Pty module default", () => {
    const error = Pty.ptyError({
      code: "exited",
      method: "spawn",
      description: "child died",
      exitCode: 3
    })

    expect(error._tag).toBe("flows/host/PtyError")
    expect(error.module).toBe("Pty")
    expect(error.message).toBe("exited: Pty.spawn: child died")
    expect(error.exitCode).toBe(3)
  })

  it("omits the description clause when none is given and honors a module override", () => {
    const error = Pty.ptyError({ code: "not_found", module: "NodePty", method: "resize" })

    expect(error.message).toBe("not_found: NodePty.resize")
    expect(error.exitCode).toBeUndefined()
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
