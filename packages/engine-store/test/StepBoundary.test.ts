import * as ArtifactStore from "@smthrs/artifacts-next/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"

/**
 * The production boundary now needs an `ArtifactStore` as well as a
 * `FileSystem`: blob mechanics moved to `@smthrs/artifacts-next`.
 */
const hostLayer = (fs: FileSystem.FileSystem) =>
  ArtifactStore.layerFileSystem().pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(fs)))
import { runPromise, sha256 } from "./Sha256.ts"

const descriptor: FileBoundary = {
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
    await expect(runPromise(program)).resolves.toMatchObject({
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
    await expect(runPromise(program)).resolves.toMatchObject({
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
    await expect(runPromise(program)).resolves.toMatchObject({ declaredOutputs: { output: "value" } })
    expect(replayed).toHaveLength(1)
  })

  it("fails hard mode for a declared output the step never produced", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare(descriptor)
      return yield* Effect.flip(boundary.settle(prepared))
    }).pipe(Effect.provide(StepBoundary.layerTest({ missingOutputs: ["output.txt"], diffIdentity: "d4" })))
    await expect(runPromise(program)).resolves.toMatchObject({
      _tag: "flows/engine-store/MissingDeclaredOutput",
      code: "missing_declared_output",
      paths: ["output.txt"],
      diffIdentity: "d4"
    })
  })

  it("records a missing declared output as an expected-mode deviation", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({ ...descriptor, boundaryMode: "expected" })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ missingOutputs: ["output.txt"], diffIdentity: "d5" })))
    // A deviation of ANY variant bars the evidence from the shared cache —
    // `ActionPersistence` gates `recordCache` on `deviation === undefined` —
    // so an unexplained absence never reaches another host in either mode.
    await expect(runPromise(program)).resolves.toMatchObject({
      deviation: { _tag: "MissingDeclaredOutput", paths: ["output.txt"], diffIdentity: "d5" }
    })
  })

  it("legalizes an absence the boundary declared as a removal", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({
        ...descriptor,
        writeSet: ["output.txt"],
        removes: ["stale.txt"]
      })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ missingOutputs: ["stale.txt"], changedPaths: ["stale.txt"] })))
    const evidence = await runPromise(program)
    expect(evidence.deviation).toBeUndefined()
  })

  it("fails closed when the host does not support boundaries", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      return yield* Effect.flip(boundary.prepare(descriptor))
    }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
    await expect(runPromise(program)).resolves.toMatchObject({
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
    await expect(runPromise(program)).resolves.toHaveLength(2)
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
    return { files, layer: StepBoundary.layer.pipe(Layer.provide(hostLayer(fs))) }
  }

  const declared = (content: string): FileBoundary => ({
    readSet: [{ path: "input.txt", digest: sha256(content) }],
    writeSet: ["output.txt"],
    boundaryMode: "hard"
  })

  it("measures the declared read set for real instead of echoing the declaration", async () => {
    const host = memoryFs({ "input.txt": "post-edit content" })
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("pre-edit content"))
      }).pipe(Effect.provide(host.layer))
    )
    // The stale declaration must be refused: the measured digest differs.
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
    expect(prepared.readSnapshot[0]!.digest).toBe(sha256("post-edit content"))
  })

  it("accepts a declaration that still matches the measured files", async () => {
    const host = memoryFs({ "input.txt": "stable content" })
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("stable content"))
      }).pipe(Effect.provide(host.layer))
    )
    expect(StepBoundary.readSetMatches(prepared)).toBe(true)
  })

  it("reports a vanished declared read as a mismatch", async () => {
    const host = memoryFs({})
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("was here"))
      }).pipe(Effect.provide(host.layer))
    )
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
  })

  it("fails a hard boundary whose declared read was mutated outside the write set", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const failure = await runPromise(
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
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
        host.files.set("input.txt", encoder.encode("scribbled"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toMatchObject({ _tag: "ExpectedSetDeviation", paths: ["input.txt"] })
  })

  it("hard-fails a declared output the body never produced", async () => {
    // Bazel's `checkOutputs`. Recording the absence as `digest: null` would
    // cache the claim "this file should not exist", and every later
    // `replayOutputs` would act on it by DELETING the path on a workspace that
    // never ran the step — a crash mid-body would poison the cache with an
    // eraser.
    const host = memoryFs({ "input.txt": "original" })
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        // The body never wrote `output.txt`.
        return yield* Effect.flip(boundary.settle(prepared))
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/MissingDeclaredOutput",
      code: "missing_declared_output",
      paths: ["output.txt"]
    })
  })

  it("records the absence as a deviation under an expected boundary", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toMatchObject({ _tag: "MissingDeclaredOutput", paths: ["output.txt"] })
  })

  it("legalizes a declared removal, and replay still deletes it", async () => {
    const producer = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          ...declared("original"),
          writeSet: ["output.txt"],
          removes: ["stale.txt"]
        })
        producer.files.set("output.txt", encoder.encode("built"))
        producer.files.delete("stale.txt")
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(producer.layer))
    )
    // Declared, therefore evidence rather than a defect — and it keeps the
    // `digest: null` capture that makes replay delete the path.
    expect(evidence.deviation).toBeUndefined()

    const consumer = memoryFs({ "stale.txt": "still here" })
    await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(evidence)
      }).pipe(Effect.provide(consumer.layer))
    )
    expect(consumer.files.has("stale.txt")).toBe(false)
    expect(decoder.decode(consumer.files.get("output.txt"))).toBe("built")
  })

  it("does not count a declared removal as an undeclared write", async () => {
    const host = memoryFs({ "input.txt": "original", "output.txt": "built" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          readSet: [{ path: "input.txt", digest: sha256("original") }],
          writeSet: ["output.txt"],
          removes: ["input.txt"],
          boundaryMode: "hard"
        })
        host.files.delete("input.txt")
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toBeUndefined()
  })

  it("captures write-set outputs and re-materializes them on a fresh workspace", async () => {
    const producer = memoryFs({ "input.txt": "original" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        producer.files.set("output.txt", encoder.encode("produced artifact"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(producer.layer))
    )
    // `diffIdentity` is a `Key` now, not a bare Sha256 hex: it goes through
    // the repo's one hashing chokepoint, so it carries the `key1_` version
    // marker its derivation is named by.
    expect(evidence.diffIdentity).toMatch(/^key1_[0-9a-f]{64}$/)

    // A different workspace that never ran the step, plus stale garbage at a
    // path the evidence records as absent.
    const replayer = memoryFs({ "stale.txt": "left over" })
    const staleEvidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          // A declared read that is also a declared write is exempt from the
          // undeclared-mutation check: mutating it is the declared contract.
          readSet: [{ path: "output.txt", digest: sha256("pre-state") }],
          writeSet: ["output.txt"],
          // The digest-null capture that makes replay delete a path is now
          // reachable only through a DECLARED removal: an undeclared absence
          // is a `MissingDeclaredOutput` defect, because caching it would hand
          // every later replay an eraser.
          removes: ["stale.txt", "gone.txt"],
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
    await runPromise(
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

  it("classifies undecodable inline content as corruption, not a host failure (issue #159)", async () => {
    // A tampered inline row that is no longer valid base64 is cache-origin
    // corruption exactly like a digest mismatch: it must raise
    // `BoundaryCorruption` so the caller routes it to the Inconsistency
    // receiver instead of retrying it as a transient host refusal.
    const host = memoryFs({})
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs({
            declaredOutputs: {
              outputs: [{
                path: "output.txt",
                digest: "aa".repeat(32),
                sizeBytes: 3,
                content: "%%%not-base64%%%"
              }]
            },
            diffIdentity: "corrupt-inline"
          })
        )
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/BoundaryCorruption",
      code: "boundary_corruption",
      path: "output.txt",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "invalid_base64"
    })
    expect(host.files.has("output.txt")).toBe(false)
  })

  it("classifies undecodable legacy inline content as corruption too (issue #159)", async () => {
    const host = memoryFs({})
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs({
            declaredOutputs: { outputs: [{ path: "legacy.txt", content: "%%%not-base64%%%" }] },
            diffIdentity: "corrupt-legacy"
          })
        )
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/BoundaryCorruption",
      code: "boundary_corruption",
      path: "legacy.txt",
      recordedDigest: "legacy_inline",
      measuredDigest: "invalid_base64"
    })
  })

  it("refuses to replay evidence recorded without materializable outputs", async () => {
    const host = memoryFs({})
    const failure = await runPromise(
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
    const failure = await runPromise(
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
        Effect.provide(StepBoundary.layer.pipe(Layer.provide(hostLayer(fs))))
      )
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
  })
})

describe("StepBoundary stays importable from a browser bundle (issue #114)", () => {
  it("has no module-scope node: imports", async () => {
    // The module exports the contract schemas, the service tag, and
    // `layerTest` — all of which a browser composition must import — so a
    // module-scope node: dependency would drag Node builtins into every
    // bundle. Base64 goes through the platform-neutral `effect/Encoding`.
    const fs = await import("node:fs/promises")
    const url = await import("node:url")
    const source = await fs.readFile(
      url.fileURLToPath(new URL("../src/StepBoundary.ts", import.meta.url)),
      "utf8"
    )
    expect(source).not.toMatch(/from "node:/)
  })
})
