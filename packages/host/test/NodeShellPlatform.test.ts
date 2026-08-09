/**
 * The platform-conditional halves of `NodeShell`: the synchronous spawn
 * failure, and the Windows shell/argument/termination forms, which CI never
 * reaches because it runs POSIX. `process.platform` is swapped for the duration
 * of a case so the Windows code is executed rather than merely declared.
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as NodeShell from "../src/node/NodeShell.ts"
import { Shell } from "../src/Shell.ts"

const NUL = String.fromCharCode(0)

const withShell = <A, E>(f: (shell: Shell) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.provide(Effect.flatMap(Shell, f), NodeShell.layer))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!

const setPlatform = (platform: string): void => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform })
}

const restorePlatform = (): void => {
  Object.defineProperty(process, "platform", platformDescriptor)
}

/**
 * Runs `command`, lets it live for `aliveMs`, then interrupts it — optionally
 * while `process.platform` reports something else. The fiber is forked inside
 * the same runtime that interrupts it, so the child is guaranteed to be
 * running by then.
 */
const interruptAfter = async (command: string, aliveMs: number, platform?: string): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const shell = yield* Shell
      const fiber = yield* Effect.forkChild(shell.exec(command), { startImmediately: true })
      yield* Effect.sleep(aliveMs)
      if (platform !== undefined) setPlatform(platform)
      try {
        yield* Fiber.interrupt(fiber)
      } finally {
        if (platform !== undefined) restorePlatform()
      }
    }).pipe(Effect.provide(NodeShell.layer))
  )
}

describe.skipIf(process.platform === "win32")("NodeShell spawn failure", () => {
  it("fails with `spawn_error` when the spawn call itself throws", async () => {
    const error = await withShell((shell) => Effect.flip(shell.exec("true", { env: { BAD: `x${NUL}y` } })))

    expect(error).toMatchObject({ code: "spawn_error" })
    expect(error.message).toMatch(/^Shell\.exec: /)
  })
})

describe.skipIf(process.platform === "win32")("NodeShell on Windows", () => {
  it("runs `exec` through `cmd.exe /d /s /c`", async () => {
    setPlatform("win32")
    try {
      // `cmd.exe` does not exist on this machine, so the argv this branch builds
      // is observable through the failure it produces.
      const error = await withShell((shell) => Effect.flip(shell.exec("dir")))

      expect(error).toMatchObject({ code: "shell_unavailable" })
      expect(error.message).toBe("Shell.exec: spawn cmd.exe ENOENT")
    } finally {
      restorePlatform()
    }
  })

  it("runs `stream` through `cmd.exe` too", async () => {
    setPlatform("win32")
    try {
      const error = await withShell((shell) => Effect.flip(Stream.runDrain(shell.stream("dir"))))

      expect(error).toMatchObject({ code: "shell_unavailable" })
      expect(error.message).toBe("Shell.execStream: spawn cmd.exe ENOENT")
    } finally {
      restorePlatform()
    }
  })

  it("falls back to SIGKILL when taskkill cannot reach the process tree", async () => {
    // `exec` replaces the POSIX test shell with the long-lived child, matching
    // the single process handle the Windows fallback owns. Without SIGKILL,
    // Fiber.interrupt cannot observe `close` and the finite test timeout fails.
    await interruptAfter("exec /bin/sleep 30", 50, "win32")
  })

  describe("with a taskkill that outlives the child", () => {
    let directory: string
    let previousPath: string | undefined

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "flows-fake-taskkill-"))
      await writeFile(join(directory, "taskkill"), "#!/bin/sh\n/bin/sleep 0.4\n")
      await chmod(join(directory, "taskkill"), 0o755)
      previousPath = process.env.PATH
      process.env.PATH = `${directory}:${previousPath ?? ""}`
    })

    afterAll(async () => {
      process.env.PATH = previousPath
      await rm(directory, { recursive: true, force: true })
    })

    it("leaves a child that exited on its own unsignalled", async () => {
      const marker = join(directory, "finished")

      await interruptAfter(`/bin/sleep 0.15; : > ${JSON.stringify(marker)}`, 50, "win32")
      // Let the slow taskkill return and take its no-op branch.
      await Effect.runPromise(Effect.sleep(600))

      // taskkill was still running when the child finished by itself, so the
      // callback must not signal an already-dead process.
      expect(existsSync(marker)).toBe(true)
    })
  })
})

describe.skipIf(process.platform === "win32")("NodeShell process-group termination", () => {
  let directory: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-node-shell-group-"))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it("signals the child directly when its process group cannot be signalled", async () => {
    const marker = join(directory, "survived")
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    let groupSignals: number
    try {
      await interruptAfter(`/bin/sleep 0.4; : > ${JSON.stringify(marker)}`, 50)
      groupSignals = kill.mock.calls.length
    } finally {
      kill.mockRestore()
    }
    await Effect.runPromise(Effect.sleep(600))

    // The group signal was attempted and refused, so only the direct
    // `child.kill` can have stopped the child before it wrote its marker.
    expect(groupSignals).toBe(1)
    expect(existsSync(marker)).toBe(false)
  })
})
