/**
 * `Pty.spawn` failure modes. Both the synchronous throw (`Effect.try`) and the
 * asynchronous `error` event a child emits when it cannot start must arrive as
 * typed `PtyError`s, never as an unhandled process-level event.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as NodePty from "../src/node/NodePty.ts"
import { Pty } from "../src/Pty.ts"

const NUL = String.fromCharCode(0)

const spawn = (command: string, options: { cwd?: string; env?: Record<string, string> }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Pty, (pty) => Effect.flip(pty.spawn(command, { cols: 80, rows: 24, ...options })))
    ).pipe(Effect.provide(NodePty.layer))
  )

describe.skipIf(process.platform === "win32")("NodePty spawn failures", () => {
  it("reports `not_found` when the shell cannot be started in the requested cwd", async () => {
    const error = await spawn("echo hi", { cwd: "/flows/definitely/absent" })

    expect(error).toMatchObject({ code: "not_found" })
    expect(error.message).toMatch(/^Pty\.spawn: /)
  })

  it("reports `unknown` when the spawn call throws for a non-errno reason", async () => {
    const error = await spawn("echo hi", { env: { BAD: `x${NUL}y` } })

    expect(error).toMatchObject({ code: "unknown" })
    expect(error.message).toMatch(/^Pty\.spawn: /)
  })
})
