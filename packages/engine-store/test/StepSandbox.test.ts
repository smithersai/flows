import type { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as SandboxedExecution from "../src/internal/SandboxedExecution.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const decoder = new TextDecoder()
const descriptor: FileBoundary = {
  readSet: [{ path: "src/input.txt", digest: sha256("input") }],
  writeSet: ["out/result.txt"],
  boundaryMode: "hard"
}

describe("StepSandbox", () => {
  it("exposes declared reads and copies declared writes back", async () => {
    const memory = await runPromise(WorkspaceSandbox.makeMemory({ "src/input.txt": "input" }))
    const service = StepSandbox.make(memory.service)
    const sandbox = await runPromise(service.open)
    const settlement = await runPromise(SandboxedExecution.execute({
      sandbox,
      descriptor,
      workflow: Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const input = yield* fs.readFileString("src/input.txt")
        yield* fs.writeFileString("out/result.txt", `${input}!`)
        return input
      })
    }))
    expect(settlement.result).toBe("input")
    expect(settlement.files.map((file) => file.path)).toEqual(["out/result.txt"])
    const files = await runPromise(memory.files)
    expect(decoder.decode(files.find((file) => file.path === "out/result.txt")?.content)).toBe("input!")
  })

  it("turns an undeclared read into the typed refusal", async () => {
    const memory = await runPromise(WorkspaceSandbox.makeMemory({
      "src/input.txt": "input",
      "src/secret.txt": "secret"
    }))
    const failure = await runPromise(Effect.flip(SandboxedExecution.execute({
      sandbox: memory.service,
      descriptor,
      workflow: Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("src/secret.txt"))
    })))
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/UndeclaredRead",
      code: "undeclared_read",
      paths: ["src/secret.txt"]
    })
  })

  it("keeps the typed refusal when the host copied only declared reads", async () => {
    const sandbox = WorkspaceSandbox.makeHosted({
      root: "",
      snapshot: () => Effect.succeed(new Map([["src/input.txt", new TextEncoder().encode("input")]])),
      baseline: () => Effect.succeed(undefined),
      retain: (bytes) => Effect.succeed(bytes),
      commit: () => Effect.void
    })
    const failure = await runPromise(Effect.flip(SandboxedExecution.execute({
      sandbox,
      descriptor,
      workflow: Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString("src/secret.txt"))
    })))
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/UndeclaredRead",
      code: "undeclared_read",
      paths: ["src/secret.txt"]
    })
  })

  it("leaves the host untouched when the scoped execution is interrupted", async () => {
    const memory = await runPromise(WorkspaceSandbox.makeMemory({ "src/input.txt": "input" }))
    await runPromise(Effect.gen(function*() {
      const fiber = yield* SandboxedExecution.execute({
        sandbox: memory.service,
        descriptor,
        workflow: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString("out/result.txt", "partial")
          return yield* Effect.never
        })
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.interrupt(fiber)
    }))
    expect((await runPromise(memory.files)).some((file) => file.path === "out/result.txt")).toBe(false)
  })

  it("provides deterministic and fail-closed layers", async () => {
    const opened = await runPromise(
      Effect.flatMap(StepSandbox.StepSandbox, (service) => service.open).pipe(
        Effect.provide(StepSandbox.layerTest({ "src/input.txt": "input" }))
      )
    )
    expect(opened).toBeDefined()
    const unsupported = await runPromise(
      Effect.flatMap(StepSandbox.StepSandbox, (service) => Effect.flip(service.open)).pipe(
        Effect.provide(StepSandbox.layerNoop)
      )
    )
    expect(unsupported).toMatchObject({ code: "unsupported_boundary" })
  })
})
