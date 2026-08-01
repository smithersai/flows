/**
 * Issue #113: the production `settle` inlined every declared write's entire
 * content as base64 into `BoundaryEvidence.declaredOutputs`, persisted
 * verbatim into the attempt row meta and the shared cache entry and
 * round-tripped on every replay — a 50MB artifact multiplied ~67MB of
 * base64 into every row with no bound anywhere. Temporal enforces hard blob
 * size limits for exactly this reason.
 *
 * Outputs are now recorded by content digest: small outputs stay inline
 * under an explicit byte bound, larger ones are written to a
 * content-addressed object directory on the host and the row carries only
 * `{path, digest, sizeBytes}`. A replay that cannot resolve a referenced
 * blob refuses with `UnsupportedBoundary`, which the issue-#107 call sites
 * turn into a real execution instead of a failure.
 */
import { FileSystem } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** An in-memory host filesystem with directory-aware writes. */
const memoryFs = (seed: Record<string, string>) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(seed).map(([path, content]) => [path, encoder.encode(content)])
  )
  const directories = new Set<string>()
  const fs = FileSystem.makeNoop({
    exists: ((path: string) => Effect.succeed(files.has(path))) as never,
    readFile: ((path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path)!)
        : Effect.fail(new Error(`ENOENT: ${path}`))) as never,
    makeDirectory: ((path: string) =>
      Effect.sync(() => {
        directories.add(path)
      })) as never,
    writeFile: ((path: string, bytes: Uint8Array) =>
      Effect.sync(() => {
        files.set(path, bytes)
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, directories, fs }
}

const boundaryLayer = (fs: FileSystem.FileSystem, options?: StepBoundary.FileSystemOptions) =>
  Layer.succeed(StepBoundary.StepBoundary, StepBoundary.makeFileSystem(fs, options))

const descriptor: StepBoundary.Descriptor = {
  readSet: [{ path: "input.txt", digest: Digest.digest("original") }],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const settleWithArtifact = (host: ReturnType<typeof memoryFs>, artifact: string, maxInlineBytes: number) =>
  Effect.gen(function*() {
    const boundary = yield* StepBoundary.StepBoundary
    const prepared = yield* boundary.prepare(descriptor)
    host.files.set("artifact.bin", encoder.encode(artifact))
    return yield* boundary.settle(prepared)
  }).pipe(
    Effect.provide(boundaryLayer(host.fs, { maxInlineBytes, objectsDirectory: ".objects" }))
  )

const outputsOf = (evidence: StepBoundary.BoundaryEvidence) =>
  (evidence.declaredOutputs as {
    readonly outputs: ReadonlyArray<{
      readonly path: string
      readonly digest: string | null
      readonly sizeBytes?: number
      readonly content?: string
    }>
  }).outputs

describe("materialized outputs are digest-referenced and bounded (issue #113)", () => {
  it("an output over the inline bound is stored as a content-addressed blob, not inlined", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const artifact = "x".repeat(64)
    const evidence = await Effect.runPromise(settleWithArtifact(host, artifact, 16))
    const [output] = outputsOf(evidence)
    expect(output!.digest).toBe(Digest.digest(artifact))
    expect(output!.sizeBytes).toBe(64)
    // The row carries a reference, never the 64-byte payload.
    expect(output!.content).toBeUndefined()
    expect(JSON.stringify(evidence)).not.toContain("xxxxxxxx")
    // The payload lives in the host's content-addressed object directory.
    expect(decoder.decode(host.files.get(`.objects/${Digest.digest(artifact)}`))).toBe(artifact)
  })

  it("a small output stays inline under the bound and replays without the object store", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const evidence = await Effect.runPromise(settleWithArtifact(host, "small", 16))
    const [output] = outputsOf(evidence)
    expect(output!.content).toBeDefined()
    // Inline evidence is self-contained: a fresh workspace with no object
    // directory still materializes it.
    const fresh = memoryFs({})
    await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(evidence)
      }).pipe(Effect.provide(boundaryLayer(fresh.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))
    )
    expect(decoder.decode(fresh.files.get("artifact.bin"))).toBe("small")
  })

  it("replays a blob-referenced output from the object store on the same host", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const artifact = "y".repeat(64)
    const evidence = await Effect.runPromise(settleWithArtifact(host, artifact, 16))
    // Wipe the workspace output; the object store survives.
    host.files.delete("artifact.bin")
    await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(evidence)
      }).pipe(Effect.provide(boundaryLayer(host.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))
    )
    expect(decoder.decode(host.files.get("artifact.bin"))).toBe(artifact)
  })

  it("refuses the replay when a referenced blob is missing, instead of writing garbage", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const artifact = "z".repeat(64)
    const evidence = await Effect.runPromise(settleWithArtifact(host, artifact, 16))
    // A different host that never ran the step has no object store: the
    // refusal routes the #107 call sites to a real execution.
    const fresh = memoryFs({})
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(boundary.replayOutputs(evidence))
      }).pipe(Effect.provide(boundaryLayer(fresh.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
    expect(fresh.files.has("artifact.bin")).toBe(false)
  })

  it("undecodable inline content refuses rather than materializing garbage", async () => {
    const host = memoryFs({})
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(boundary.replayOutputs({
          declaredOutputs: {
            outputs: [{ path: "artifact.bin", digest: "d", sizeBytes: 4, content: "%%%not-base64%%%" }]
          },
          diffIdentity: "corrupt"
        }))
      }).pipe(Effect.provide(boundaryLayer(host.fs)))
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
  })
})
