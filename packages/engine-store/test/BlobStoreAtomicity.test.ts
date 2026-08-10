/**
 * Issue #131: the #117 temp blob path was unique only per `makeFileSystem`
 * instance — a closure counter starting at 0 — so two processes (or two
 * boundary instances over one shared objects directory, the default
 * `.flows/objects`) spilling the same digest both wrote `<blob>.tmp-0`: one
 * writer's truncating open clobbered the other's completed temp file, the
 * first rename published torn bytes at the canonical content address, and
 * the loser's rename failed ENOENT. Temp names now fold per-instance
 * writer material (pid + random token), so concurrent writers — in-process
 * or cross-process — never share a temp path.
 */
import type { FileBoundary } from "@smthrs/engine/FileBoundary"
import { FileSystem } from "@smthrs/kernel"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * An in-memory host filesystem shared by several boundary instances, whose
 * temp-file writes park on a latch until every expected writer has written —
 * pinning the exact cross-writer interleaving of the #131 collision.
 */
const sharedFs = (options: { readonly parkTempWritesUntil: number }) => {
  const files = new Map<string, Uint8Array>()
  const tempWrites: Array<string> = []
  let released: Deferred.Deferred<void> | undefined
  const latch = Effect.gen(function*() {
    released = released ?? (yield* Deferred.make<void>())
    if (tempWrites.length >= options.parkTempWritesUntil) {
      yield* Deferred.done(released, Exit.void)
    }
    yield* Deferred.await(released)
  })
  const fs = FileSystem.makeNoop({
    exists: ((path: string) => Effect.succeed(files.has(path))) as never,
    readFile: ((path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path)!)
        : Effect.fail(new Error(`ENOENT: ${path}`))) as never,
    makeDirectory: (() => Effect.void) as never,
    readDirectory: (() => Effect.fail(new Error("ENOENT: no objects directory"))) as never,
    writeFile: ((path: string, bytes: Uint8Array) =>
      Effect.gen(function*() {
        files.set(path, bytes)
        if (path.includes(".tmp-")) {
          tempWrites.push(path)
          yield* latch
        }
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        const bytes = files.get(from)
        if (bytes === undefined) return Effect.fail(new Error(`ENOENT: ${from}`))
        files.set(to, bytes)
        files.delete(from)
        return Effect.void
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, tempWrites, fs }
}

const descriptor: FileBoundary = {
  readSet: [],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const artifact = "shared-oversized-artifact-content"
const digest = sha256(encoder.encode(artifact))
const blobPath = `.flows/objects/${digest}`

const spill = (boundary: StepBoundary.Service, host: ReturnType<typeof sharedFs>) =>
  Effect.gen(function*() {
    const prepared = yield* boundary.prepare(descriptor)
    host.files.set("artifact.bin", encoder.encode(artifact))
    return yield* boundary.settle(prepared)
  })

describe("temp blob paths are unique across boundary instances (issue #131)", () => {
  it("lets two instances spill one digest into a shared objects directory concurrently", async () => {
    const host = sharedFs({ parkTempWritesUntil: 2 })
    // Two service instances over ONE filesystem: the cross-process shape —
    // each instance's temp counter starts fresh, exactly as two processes'
    // counters both start at 0.
    const first = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const second = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const results = await runPromise(
      Effect.all([spill(first, host), spill(second, host)], { concurrency: 2 }).pipe(Effect.exit)
    )
    // Both captures survive: neither writer's temp file was clobbered and
    // neither rename failed ENOENT under the loser's deleted temp path.
    expect(Exit.isSuccess(results)).toBe(true)
    // The two writers never shared a temp path.
    expect(new Set(host.tempWrites).size).toBe(2)
    // And the canonical address holds the intact bytes.
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    // No temp files remain after publication.
    expect([...host.files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([])
  })
})

/**
 * Issue #138: a crash (or failed rename) between the temp write and the
 * rename left `.tmp-*` files in the objects directory forever — no cleanup
 * on error, no sweep on open, and `materialize` only ever reads canonical
 * paths, so orphans accumulated unboundedly across crashes.
 */
describe("orphaned temp blobs are reclaimed (issue #138)", () => {
  const gcFs = (options: {
    readonly seed?: Record<string, string>
    readonly mtimes?: Record<string, number>
    readonly failRenameTo?: string
    readonly failReadOf?: string
  }) => {
    const files = new Map<string, Uint8Array>(
      Object.entries(options.seed ?? {}).map(([path, content]) => [path, encoder.encode(content)])
    )
    let directoryReads = 0
    // Per-path instrumentation: the healthy-blob-skip and repeat-capture
    // cells below assert on IO counts, not just final state — final state is
    // identical whether capture skips or rewrites through temp+rename
    // (issue #143).
    const writes: Array<string> = []
    const reads: Array<string> = []
    const fs = FileSystem.makeNoop({
      exists: ((path: string) => Effect.succeed(files.has(path))) as never,
      readFile: ((path: string) =>
        Effect.suspend(() => {
          reads.push(path)
          return files.has(path) && path !== options.failReadOf
            ? Effect.succeed(files.get(path)!)
            : Effect.fail(new Error(`ENOENT: ${path}`))
        })) as never,
      makeDirectory: (() => Effect.void) as never,
      readDirectory: ((directory: string) =>
        Effect.sync(() => {
          directoryReads++
          const prefix = `${directory}/`
          return [...files.keys()]
            .filter((path) => path.startsWith(prefix))
            .map((path) => path.slice(prefix.length))
        })) as never,
      stat: ((path: string) => {
        const mtime = options.mtimes?.[path]
        return mtime === undefined
          ? Effect.fail(new Error(`ENOENT: ${path}`))
          : Effect.succeed({ mtime: Option.some(new Date(mtime)) })
      }) as never,
      writeFile: ((path: string, bytes: Uint8Array) =>
        Effect.sync(() => {
          writes.push(path)
          files.set(path, bytes)
        })) as never,
      rename: ((from: string, to: string) =>
        Effect.suspend(() => {
          if (to === options.failRenameTo) return Effect.fail(new Error(`EIO: ${to}`))
          const bytes = files.get(from)
          if (bytes === undefined) return Effect.fail(new Error(`ENOENT: ${from}`))
          files.set(to, bytes)
          files.delete(from)
          return Effect.void
        })) as never,
      remove: ((path: string) =>
        Effect.sync(() => {
          files.delete(path)
        })) as never
    })
    return { files, directoryReads: () => directoryReads, writes, reads, fs }
  }

  it("removes the temp file when the publishing rename fails", async () => {
    const host = gcFs({ failRenameTo: blobPath })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const exit = await runPromise(spill(boundary, host as never).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    // The failed publication does not strand its scratch file.
    expect([...host.files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([])
  })

  it("sweeps stale orphans on first spill, keeps fresh temps and canonical blobs, and sweeps once", async () => {
    const now = Date.now()
    const stale = `.flows/objects/old.tmp-dead-0`
    const fresh = `.flows/objects/live.tmp-live-0`
    const unrelated = `.flows/objects/${"c".repeat(8)}`
    const host = gcFs({
      seed: { [stale]: "torn", [fresh]: "in-flight", [unrelated]: "blob" },
      mtimes: {
        [stale]: now - 2 * 60 * 60 * 1000,
        [fresh]: now
      }
    })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await runPromise(spill(boundary, host as never))
    // The crash orphan is reclaimed; a live writer's fresh temp and the
    // canonical content-addressed blobs survive.
    expect(host.files.has(stale)).toBe(false)
    expect(host.files.has(fresh)).toBe(true)
    expect(host.files.has(unrelated)).toBe(true)
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    // The sweep runs once per store, not once per capture.
    host.files.set("artifact.bin", encoder.encode("second-artifact-body"))
    await runPromise(
      Effect.gen(function*() {
        const prepared = yield* boundary.prepare(descriptor)
        return yield* boundary.settle(prepared)
      })
    )
    expect(host.directoryReads()).toBe(1)
  })

  it("heals a corrupt existing blob at the canonical address (issue #132)", async () => {
    // A truncated blob left by the pre-#117 non-atomic writer (or disk
    // corruption) was trusted forever: capture skipped the write on bare
    // existence while materialize digest-verifies and refuses, so every
    // replay of the digest failed permanently even though the capturing
    // process held the correct bytes. Capture now digest-verifies the
    // existing blob and rewrites on mismatch.
    const host = gcFs({ seed: { [blobPath]: "torn-partial-bytes" } })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const settled = await runPromise(spill(boundary, host as never))
    // The canonical address now holds the true content...
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    // ...so the recorded reference is materializable again.
    const output = (settled as { declaredOutputs: { outputs: Array<never> } }).declaredOutputs.outputs[0]
    await runPromise(boundary.replayOutputs({ declaredOutputs: { outputs: [output] } } as never))
    expect(decoder.decode(host.files.get("artifact.bin"))).toBe(artifact)
    expect([...host.files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([])
    // The heal went through the atomic temp+rename writer.
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
  })

  it("rewrites an existing blob the host cannot read back", async () => {
    // An unreadable blob is indistinguishable from a corrupt one at the
    // canonical address; the capture holds the true bytes, so it heals
    // rather than trusts.
    const host = gcFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await runPromise(spill(boundary, host as never))
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    // The unreadable blob was actually rewritten, not silently trusted.
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
  })

  it("leaves a healthy existing blob unwritten", async () => {
    // The content-addressed dedupe survives the verification: a blob whose
    // bytes match its digest is never rewritten.
    const host = gcFs({ seed: { [blobPath]: artifact } })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await runPromise(spill(boundary, host as never))
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    // The skip itself is observed (issue #143): final state alone cannot
    // distinguish a skip from an unconditional rewrite, because a
    // successful temp+rename also leaves the right bytes and no `.tmp-*`
    // key behind. A healthy verified blob must cause NO write at all.
    expect(host.writes).toEqual([])
    expect([...host.files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([])
  })

  it("verifies an existing blob once per store lifetime, not once per capture (issue #144)", async () => {
    // The #132 verification is O(blob size): re-reading and re-hashing the
    // whole existing blob on EVERY capture of a known digest makes the
    // content-addressed dedupe fast path linear in blob size on every
    // re-spill of a long run. One verified match (or one atomic publish by
    // this store) is proof enough for the store's lifetime — the store is
    // the only writer shape that publishes to the address, and a mismatch
    // introduced behind its back is exactly the case `materialize`'s own
    // digest check still refuses.
    const host = gcFs({ seed: { [blobPath]: artifact } })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await runPromise(spill(boundary, host as never))
    await runPromise(spill(boundary, host as never))
    // The pre-existing blob was digest-verified exactly once; the second
    // capture trusted the verified-digest set and skipped the re-read.
    expect(host.reads.filter((path) => path === blobPath)).toHaveLength(1)
    expect(host.writes).toEqual([])
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
  })

  it("trusts its own atomic publication on the next capture of the digest", async () => {
    // A blob this store just published through temp+rename needs no
    // verification read at all on a later capture of the same digest.
    const host = gcFs({})
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await runPromise(spill(boundary, host as never))
    await runPromise(spill(boundary, host as never))
    expect(host.reads.filter((path) => path === blobPath)).toHaveLength(0)
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
  })

  it("evicts the verified-digest memo when materialization finds corruption, so capture heals (issue #145)", async () => {
    // The #144 memo must never outlive the proof it caches: after this store
    // verifies (or publishes) a digest, external corruption of the blob made
    // every materialize fail with a digest mismatch, while every later
    // capture of the same content hit the memo, skipped the hash check, and
    // skipped the #132 healing rewrite — a permanent failure for the store's
    // lifetime even though the process held the correct bytes. A failed or
    // mismatching materialization now drops the memo entry so the next
    // capture re-verifies and repairs the address.
    const host = gcFs({})
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const settled = await runPromise(spill(boundary, host as never))
    const output = (settled as { declaredOutputs: { outputs: Array<never> } }).declaredOutputs.outputs[0]
    // External corruption behind the store's back, after the memo is primed.
    host.files.set(blobPath, encoder.encode("torn-partial-bytes"))
    const refused = await runPromise(
      boundary.replayOutputs({ declaredOutputs: { outputs: [output] } } as never).pipe(Effect.exit)
    )
    expect(Exit.isFailure(refused)).toBe(true)
    // The next capture of the same content must NOT trust the stale memo:
    // it re-verifies, catches the mismatch, and heals through temp+rename.
    await runPromise(spill(boundary, host as never))
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
    // And the healed address materializes again.
    await runPromise(boundary.replayOutputs({ declaredOutputs: { outputs: [output] } } as never))
    expect(decoder.decode(host.files.get("artifact.bin"))).toBe(artifact)
  })

  it("evicts the verified-digest memo when the blob cannot be read at materialize (issue #145)", async () => {
    const host = gcFs({ failReadOf: blobPath })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const settled = await runPromise(spill(boundary, host as never))
    const output = (settled as { declaredOutputs: { outputs: Array<never> } }).declaredOutputs.outputs[0]
    // The blob exists but the host cannot read it back.
    const refused = await runPromise(
      boundary.replayOutputs({ declaredOutputs: { outputs: [output] } } as never).pipe(Effect.exit)
    )
    expect(Exit.isFailure(refused)).toBe(true)
    // The stale memo is gone: the next capture re-verifies, cannot read the
    // blob either, and heals through a second atomic rewrite.
    await runPromise(spill(boundary, host as never))
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
  })

  it("evicts the verified-digest memo when the blob vanishes at materialize (issue #145)", async () => {
    const host = gcFs({})
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const settled = await runPromise(spill(boundary, host as never))
    const output = (settled as { declaredOutputs: { outputs: Array<never> } }).declaredOutputs.outputs[0]
    // The blob is deleted behind the store's back.
    host.files.delete(blobPath)
    const refused = await runPromise(
      boundary.replayOutputs({ declaredOutputs: { outputs: [output] } } as never).pipe(Effect.exit)
    )
    expect(Exit.isFailure(refused)).toBe(true)
    // A later capture republishes instead of trusting the stale memo.
    await runPromise(spill(boundary, host as never))
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
  })

  it("keeps a temp file whose age cannot be measured", async () => {
    // `stat` unavailable (or failing) says nothing about the writer's
    // liveness, so the conservative sweep never deletes what it cannot age.
    const unaged = `.flows/objects/unknown.tmp-mystery-0`
    const host = gcFs({ seed: { [unaged]: "unknown-age" } })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await runPromise(spill(boundary, host as never))
    expect(host.files.has(unaged)).toBe(true)
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
  })
})
