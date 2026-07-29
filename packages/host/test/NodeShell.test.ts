import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as NodeShell from "../src/node/NodeShell.ts"
import { Shell } from "../src/Shell.ts"

describe.skipIf(process.platform === "win32")("NodeShell", () => {
  it("kills the process group and waits for descendant cleanup on interruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-node-shell-"))
    const marker = join(directory, "escaped")
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const shell = yield* Shell
          const fiber = yield* shell.exec(
            `(sleep 0.3; echo escaped > ${JSON.stringify(marker)}) & wait`
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep(50)
          yield* Fiber.interrupt(fiber)
          yield* Effect.sleep(400)
        }).pipe(Effect.provide(NodeShell.layer))
      )
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("honors timeoutMs for streaming commands", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const shell = yield* Shell
        return yield* shell.stream("sleep 2", { timeoutMs: 25 }).pipe(
          Stream.runCollect,
          Effect.flip
        )
      }).pipe(Effect.provide(NodeShell.layer))
    )

    expect(error).toMatchObject({ code: "timeout" })
  })
})
