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
import * as Encoding from "effect/Encoding"
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
  const writes: Array<string> = []
  const renames: Array<readonly [string, string]> = []
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
        writes.push(path)
        files.set(path, bytes)
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.sync(() => {
        renames.push([from, to] as const)
        const bytes = files.get(from)
        if (bytes === undefined) throw new Error(`ENOENT: ${from}`)
        files.set(to, bytes)
        files.delete(from)
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, directories, writes, renames, fs }
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

describe("legacy round-7 evidence rows still decode and replay (issue #123)", () => {
  // The exact persisted shape of commit c855553's `declaredOutputs`:
  // `{outputs: [{path, content: string | null}]}` — no digest anywhere.
  const legacyEvidence = (outputs: ReadonlyArray<{ path: string; content: string | null }>) => ({
    declaredOutputs: { outputs },
    diffIdentity: "legacy-round-7"
  })

  it("materializes a legacy inline row, deriving its digest from the decoded bytes", async () => {
    const host = memoryFs({})
    await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(legacyEvidence([
          { path: "legacy.txt", content: Encoding.encodeBase64(encoder.encode("hello from round 7")) }
        ]))
      }).pipe(Effect.provide(boundaryLayer(host.fs)))
    )
    expect(decoder.decode(host.files.get("legacy.txt"))).toBe("hello from round 7")
  })

  it("treats legacy null content as path-absent and removes the stale file", async () => {
    const host = memoryFs({ "legacy.txt": "stale" })
    await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(legacyEvidence([{ path: "legacy.txt", content: null }]))
      }).pipe(Effect.provide(boundaryLayer(host.fs)))
    )
    expect(host.files.has("legacy.txt")).toBe(false)
  })

  it("refuses undecodable legacy content instead of materializing garbage", async () => {
    const host = memoryFs({})
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs(legacyEvidence([{ path: "legacy.txt", content: "%%%not-base64%%%" }]))
        )
      }).pipe(Effect.provide(boundaryLayer(host.fs)))
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
    expect(host.files.has("legacy.txt")).toBe(false)
  })
})

describe("the aggregate inline payload is bounded (issue #122)", () => {
  it("spills outputs past maxTotalInlineBytes to the object store and still replays them", async () => {
    // Ten-byte outputs each fit the 16-byte per-output bound, but the third
    // would push the evidence's aggregate inline payload past the 24-byte
    // total bound — so it is spilled to the object directory and recorded by
    // digest reference only.
    const host = memoryFs({ "input.txt": "original" })
    const contents = ["a".repeat(10), "b".repeat(10), "c".repeat(10)]
    const options: StepBoundary.FileSystemOptions = {
      maxInlineBytes: 16,
      maxTotalInlineBytes: 24,
      objectsDirectory: ".objects"
    }
    const evidence = await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          ...descriptor,
          writeSet: ["a.bin", "b.bin", "c.bin"]
        })
        host.files.set("a.bin", encoder.encode(contents[0]!))
        host.files.set("b.bin", encoder.encode(contents[1]!))
        host.files.set("c.bin", encoder.encode(contents[2]!))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(boundaryLayer(host.fs, options)))
    )
    const outputs = outputsOf(evidence)
    expect(outputs[0]!.content).toBeDefined()
    expect(outputs[1]!.content).toBeDefined()
    // The later output carries a digest reference only, even though it
    // individually fits the per-output bound.
    expect(outputs[2]!.content).toBeUndefined()
    expect(outputs[2]!.digest).toBe(Digest.digest(contents[2]!))
    expect(JSON.stringify(evidence)).not.toContain(Encoding.encodeBase64(encoder.encode(contents[2]!)))
    expect(host.files.has(`.objects/${Digest.digest(contents[2]!)}`)).toBe(true)
    // Replay round-trips the mixed inline/reference evidence.
    host.files.delete("a.bin")
    host.files.delete("b.bin")
    host.files.delete("c.bin")
    await Effect.runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(evidence)
      }).pipe(Effect.provide(boundaryLayer(host.fs, options)))
    )
    expect(decoder.decode(host.files.get("a.bin"))).toBe(contents[0])
    expect(decoder.decode(host.files.get("b.bin"))).toBe(contents[1])
    expect(decoder.decode(host.files.get("c.bin"))).toBe(contents[2])
  })
})

describe("blob writes are atomic and materialization is digest-verified (issue #117)", () => {
  const replay = (host: ReturnType<typeof memoryFs>, evidence: StepBoundary.BoundaryEvidence) =>
    Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      return yield* Effect.flip(boundary.replayOutputs(evidence))
    }).pipe(Effect.provide(boundaryLayer(host.fs, { maxInlineBytes: 16, objectsDirectory: ".objects" })))

  it("refuses a corrupted blob at the canonical address instead of writing garbage", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const artifact = "c".repeat(64)
    const evidence = await Effect.runPromise(settleWithArtifact(host, artifact, 16))
    // The blob at the canonical content address was truncated after settle
    // — a torn write, disk corruption, or a clobbered partial file.
    host.files.set(`.objects/${Digest.digest(artifact)}`, encoder.encode("truncated"))
    host.files.delete("artifact.bin")
    const failure = await Effect.runPromise(replay(host, evidence))
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
    expect(failure.message).toMatch(/digest/)
    expect(host.files.has("artifact.bin")).toBe(false)
  })

  it("refuses inline content whose bytes do not match the recorded digest", async () => {
    const host = memoryFs({})
    const failure = await Effect.runPromise(replay(host, {
      declaredOutputs: {
        outputs: [{
          path: "artifact.bin",
          digest: Digest.digest("real"),
          sizeBytes: 4,
          content: Encoding.encodeBase64(encoder.encode("fake"))
        }]
      },
      diffIdentity: "tampered"
    }))
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
    expect(failure.message).toMatch(/digest/)
    expect(host.files.has("artifact.bin")).toBe(false)
  })

  it("writes blobs via temp+rename and never rewrites an existing valid blob", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const artifact = "t".repeat(64)
    const blobPath = `.objects/${Digest.digest(artifact)}`
    await Effect.runPromise(settleWithArtifact(host, artifact, 16))
    // The canonical address is never the direct write target: the payload
    // lands at a temp path and is renamed into place, so a crash mid-write
    // can never leave a partial file at the content address.
    expect(host.writes).not.toContain(blobPath)
    expect(host.renames).toHaveLength(1)
    expect(host.renames[0]![0]).toMatch(new RegExp(`^${blobPath}\\.tmp-`))
    expect(host.renames[0]![1]).toBe(blobPath)
    // No temp file survives the settle.
    expect([...host.files.keys()].filter((path) => path.includes(".tmp-"))).toHaveLength(0)
    // Content-addressed: a second settle of the same payload skips the write.
    await Effect.runPromise(settleWithArtifact(host, artifact, 16))
    expect(host.writes.filter((path) => path.startsWith(`${blobPath}.tmp-`))).toHaveLength(1)
    expect(host.renames).toHaveLength(1)
  })
})
