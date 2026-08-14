import { runHostContract } from "@smthrs/kernel-next/test/contract"
import { Deferred, Effect, Fiber, Schedule } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as NodeHost from "../../src/NodeHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0
const jjStatusWorks = jjAvailable && spawnSync("jj", ["status"], { stdio: "ignore" }).status === 0

runHostContract("NodeHost", NodeHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  childProcess: { expected: "success" },
  jj: jjStatusWorks
    ? { expected: "success" }
    : { expected: "failure", code: jjAvailable ? "unknown" : "not_installed" },
  httpClient: { expected: "failure", code: "TransportError" }
})

const nodeErrorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined

const waitForEsrch = (pid: number) =>
  Effect.retry(
    Effect.suspend(() => {
      try {
        process.kill(pid, 0)
        return Effect.fail("alive" as const)
      } catch (error) {
        return nodeErrorCode(error) === "ESRCH" ? Effect.void : Effect.die(error)
      }
    }),
    { times: 400, schedule: Schedule.spaced(5) }
  )

describe.skipIf(process.platform === "win32")("NodeHost child-process lifecycle", () => {
  it("reaps the child OS process when its owning fiber is interrupted", async () => {
    const pid = await Effect.runPromise(
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const pidReady = Deferred.makeUnsafe<number>()
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function*() {
              const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["10"]))
              yield* Deferred.succeed(pidReady, Number(handle.pid))
              yield* handle.exitCode
            })
          ),
          { startImmediately: true }
        )
        const pid = yield* Deferred.await(pidReady)
        expect(() => process.kill(pid, 0)).not.toThrow()
        yield* Fiber.interrupt(fiber)
        return pid
      }).pipe(Effect.provide(NodeHost.layer))
    )

    await Effect.runPromise(waitForEsrch(pid))
    let livenessError: unknown
    try {
      process.kill(pid, 0)
    } catch (error) {
      livenessError = error
    }
    expect(livenessError).toMatchObject({ code: "ESRCH" })
  })
})
