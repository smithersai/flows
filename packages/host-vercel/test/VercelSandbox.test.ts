import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as VercelSandbox from "../src/VercelSandbox.ts"

describe("VercelSandbox", () => {
  it("adapts a Vercel-shaped binding at the RemoteSandbox seam", async () => {
    const state = { closed: 0 }
    const provider = VercelSandbox.fromBinding({
      open: async () => ({
        exec: async (command) => ({ stdout: command, stderr: "", exitCode: 0 }),
        execStream: async function*() {
          yield { kind: "stdout" as const, chunk: new TextEncoder().encode("stream") }
        },
        close: async () => {
          state.closed += 1
        }
      })
    })
    const program = Effect.gen(function*() {
      yield* provider.open(provider.session)
      const result = yield* provider.exec("echo")
      const chunks = yield* Stream.runCollect(provider.execStream("echo"))
      return { result, chunks: chunks.length, closed: state.closed }
    })
    await expect(Effect.runPromise(Effect.scoped(program))).resolves.toMatchObject({
      result: { stdout: "echo" },
      chunks: 1,
      closed: 0
    })
    expect(state.closed).toBe(1)
  })

  it("preserves provider identity for callers using the shared seam", () => {
    const provider = VercelSandbox.fromBinding({
      open: async () => ({
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        execStream: async function*() {},
        close: async () => {}
      })
    })
    expect(VercelSandbox.makeProvider(provider)).toBe(provider)
  })
})
