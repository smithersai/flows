import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"

const descriptor: StepBoundary.Descriptor = {
  readSet: [{ path: "input.txt", digest: "a" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

describe("StepBoundary", () => {
  it("fails hard mode for an undeclared write", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare(descriptor)
      return yield* Effect.flip(boundary.settle(prepared))
    }).pipe(Effect.provide(StepBoundary.layerTest({ changedPaths: ["surprise.txt"], diffIdentity: "d1" })))
    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      _tag: "flows/engine-store/UndeclaredWrite",
      code: "undeclared_write",
      paths: ["surprise.txt"],
      diffIdentity: "d1"
    })
  })

  it("records expected-mode deviations", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({ ...descriptor, boundaryMode: "expected" })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ changedPaths: ["surprise.txt"], diffIdentity: "d2" })))
    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      declaredOutputs: { paths: ["output.txt"] },
      deviation: { _tag: "ExpectedSetDeviation", paths: ["surprise.txt"], diffIdentity: "d2" }
    })
  })

  it("captures outputs and re-materializes them on replay", async () => {
    const replayed: Array<StepBoundary.BoundaryEvidence> = []
    const layer = StepBoundary.layerTest({
      declaredOutputs: { output: "value" },
      onReplay: (evidence) => replayed.push(evidence)
    })
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare(descriptor)
      const evidence = yield* boundary.settle(prepared)
      yield* boundary.replayOutputs(evidence)
      return evidence
    }).pipe(Effect.provide(layer))
    await expect(Effect.runPromise(program)).resolves.toMatchObject({ declaredOutputs: { output: "value" } })
    expect(replayed).toHaveLength(1)
  })

  it("fails closed when the host does not support boundaries", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      return yield* Effect.flip(boundary.prepare(descriptor))
    }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
    await expect(Effect.runPromise(program)).resolves.toMatchObject({
      _tag: "flows/engine-store/UnsupportedBoundary",
      code: "unsupported_boundary"
    })
  })

  it("fails closed during settlement and output replay", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared: StepBoundary.PreparedBoundary = { descriptor, readSnapshot: descriptor.readSet }
      const settle = yield* Effect.flip(boundary.settle(prepared))
      const replay = yield* Effect.flip(boundary.replayOutputs({ declaredOutputs: {}, diffIdentity: "d3" }))
      return [settle, replay]
    }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
    await expect(Effect.runPromise(program)).resolves.toHaveLength(2)
  })
})
