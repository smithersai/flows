import { FileSystem } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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

/**
 * The filesystem-backed production layer (issue #104): until this layer the
 * only implementation was `layerTest`, whose `prepare` defaulted the read
 * snapshot to the declaration — so outside tests the issue-#90 dirty check
 * compared the declaration against itself and passed unconditionally, and a
 * hard-boundary application had no service to provide at all.
 */
describe("StepBoundary.layer (filesystem-backed)", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  /** A deterministic in-memory host filesystem over the kernel seam. */
  const memoryFs = (seed: Record<string, string>) => {
    const files = new Map<string, Uint8Array>(
      Object.entries(seed).map(([path, content]) => [path, encoder.encode(content)])
    )
    const fs = FileSystem.makeNoop({
      exists: ((path: string) => Effect.succeed(files.has(path))) as never,
      readFile: ((path: string) =>
        files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.die(`missing file ${path}`)) as never,
      writeFile: ((path: string, bytes: Uint8Array) =>
        Effect.sync(() => {
          files.set(path, bytes)
        })) as never,
      remove: ((path: string) =>
        Effect.sync(() => {
          files.delete(path)
        })) as never
    })
    return { files, layer: StepBoundary.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem)(fs))) }
  }

  const declared = (content: string): StepBoundary.Descriptor => ({
    readSet: [{ path: "input.txt", digest: Digest.digest(content) }],
    writeSet: ["output.txt"],
    boundaryMode: "hard"
  })

  it("measures the declared read set for real instead of echoing the declaration", async () => {
    const host = memoryFs({ "input.txt": "post-edit content" })
    const prepared = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("pre-edit content"))
      }).pipe(Effect.provide(host.layer))
    )
    // The stale declaration must be refused: the measured digest differs.
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
    expect(prepared.readSnapshot[0]!.digest).toBe(Digest.digest("post-edit content"))
  })

  it("accepts a declaration that still matches the measured files", async () => {
    const host = memoryFs({ "input.txt": "stable content" })
    const prepared = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("stable content"))
      }).pipe(Effect.provide(host.layer))
    )
    expect(StepBoundary.readSetMatches(prepared)).toBe(true)
  })

  it("reports a vanished declared read as a mismatch", async () => {
    const host = memoryFs({})
    const prepared = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("was here"))
      }).pipe(Effect.provide(host.layer))
    )
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
  })

  it("fails a hard boundary whose declared read was mutated outside the write set", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        // The body mutates a declared read that is not a declared write.
        host.files.set("input.txt", encoder.encode("scribbled"))
        return yield* Effect.flip(boundary.settle(prepared))
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/UndeclaredWrite",
      code: "undeclared_write",
      paths: ["input.txt"]
    })
  })

  it("records the mutation as a deviation under an expected boundary", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const evidence = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
        host.files.set("input.txt", encoder.encode("scribbled"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toMatchObject({ _tag: "ExpectedSetDeviation", paths: ["input.txt"] })
  })

  it("captures write-set outputs and re-materializes them on a fresh workspace", async () => {
    const producer = memoryFs({ "input.txt": "original" })
    const evidence = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        producer.files.set("output.txt", encoder.encode("produced artifact"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(producer.layer))
    )
    expect(evidence.diffIdentity).toMatch(/^[0-9a-f]{64}$/)

    // A different workspace that never ran the step, plus stale garbage at a
    // path the evidence records as absent.
    const replayer = memoryFs({ "stale.txt": "left over" })
    const staleEvidence = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          // A declared read that is also a declared write is exempt from the
          // undeclared-mutation check: mutating it is the declared contract.
          readSet: [{ path: "output.txt", digest: Digest.digest("pre-state") }],
          writeSet: ["output.txt", "stale.txt", "gone.txt"],
          boundaryMode: "hard"
        })
        replayer.files.set("output.txt", encoder.encode("produced artifact"))
        replayer.files.delete("stale.txt")
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(replayer.layer))
    )
    // "gone.txt" was recorded absent and is already absent on the target:
    // replay leaves it absent without attempting a remove.
    const target = memoryFs({ "stale.txt": "left over" })
    await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(staleEvidence)
      }).pipe(Effect.provide(target.layer))
    )
    expect(decoder.decode(target.files.get("output.txt"))).toBe("produced artifact")
    // A recorded-absent output deletes the stale file on replay.
    expect(target.files.has("stale.txt")).toBe(false)
    expect(target.files.has("gone.txt")).toBe(false)
  })

  it("refuses to replay evidence recorded without materializable outputs", async () => {
    const host = memoryFs({})
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs({ declaredOutputs: { paths: ["output.txt"] }, diffIdentity: "foreign" })
        )
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
  })
})

describe("StepBoundary.layer host failures", () => {
  it("maps a filesystem failure to UnsupportedBoundary", async () => {
    const fs = FileSystem.makeNoop({
      exists: (() => Effect.succeed(true)) as never
      // readFile keeps the noop default and fails: the host cannot measure.
    })
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.prepare({
            readSet: [{ path: "input.txt", digest: "d" }],
            writeSet: [],
            boundaryMode: "hard"
          })
        )
      }).pipe(
        Effect.provide(StepBoundary.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem)(fs))))
      )
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
  })
})
