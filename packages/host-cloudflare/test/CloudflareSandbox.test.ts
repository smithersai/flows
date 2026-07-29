import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as CloudflareSandbox from "../src/CloudflareSandbox.ts"

describe("CloudflareSandbox", () => {
  it("adapts a scoped Cloudflare Sandbox client", async () => {
    const state = { destroyed: 0 }
    const provider = CloudflareSandbox.fromBinding(() => ({
      exec: async (command) => ({ stdout: command, stderr: "", exitCode: 0 }),
      execStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream"))
            controller.close()
          }
        }),
      destroy: async () => {
        state.destroyed += 1
      }
    }))
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          yield* provider.open(provider.session)
          const executed = yield* provider.exec("echo")
          const streamed = yield* provider.execStream("echo").pipe(Stream.runCollect)
          return { executed, streamed: streamed.length }
        })
      )
    )

    expect(result).toMatchObject({ executed: { stdout: "echo" }, streamed: 1 })
    expect(state.destroyed).toBe(1)
  })
})
