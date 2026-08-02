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
import { FileSystem } from "@smithers/kernel"
import { Digest } from "@smithers/keys"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"

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

const descriptor: StepBoundary.Descriptor = {
  readSet: [],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const artifact = "shared-oversized-artifact-content"
const digest = Digest.digest(encoder.encode(artifact))
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
    const results = await Effect.runPromise(
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
  }) => {
    const files = new Map<string, Uint8Array>(
      Object.entries(options.seed ?? {}).map(([path, content]) => [path, encoder.encode(content)])
    )
    let directoryReads = 0
    const fs = FileSystem.makeNoop({
      exists: ((path: string) => Effect.succeed(files.has(path))) as never,
      readFile: ((path: string) =>
        files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))) as never,
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
    return { files, directoryReads: () => directoryReads, fs }
  }

  it("removes the temp file when the publishing rename fails", async () => {
    const host = gcFs({ failRenameTo: blobPath })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const exit = await Effect.runPromise(spill(boundary, host as never).pipe(Effect.exit))
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
    await Effect.runPromise(spill(boundary, host as never))
    // The crash orphan is reclaimed; a live writer's fresh temp and the
    // canonical content-addressed blobs survive.
    expect(host.files.has(stale)).toBe(false)
    expect(host.files.has(fresh)).toBe(true)
    expect(host.files.has(unrelated)).toBe(true)
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
    // The sweep runs once per store, not once per capture.
    host.files.set("artifact.bin", encoder.encode("second-artifact-body"))
    await Effect.runPromise(
      Effect.gen(function*() {
        const prepared = yield* boundary.prepare(descriptor)
        return yield* boundary.settle(prepared)
      })
    )
    expect(host.directoryReads()).toBe(1)
  })

  it("keeps a temp file whose age cannot be measured", async () => {
    // `stat` unavailable (or failing) says nothing about the writer's
    // liveness, so the conservative sweep never deletes what it cannot age.
    const unaged = `.flows/objects/unknown.tmp-mystery-0`
    const host = gcFs({ seed: { [unaged]: "unknown-age" } })
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    await Effect.runPromise(spill(boundary, host as never))
    expect(host.files.has(unaged)).toBe(true)
    expect(decoder.decode(host.files.get(blobPath))).toBe(artifact)
  })
})
