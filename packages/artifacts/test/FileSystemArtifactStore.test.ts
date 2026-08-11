/**
 * The filesystem artifact store's durability contract.
 *
 * These properties moved here from `@smthrs/engine-store`'s `StepBoundary`
 * along with the code (issues #117, #131, #132, #138, #143, #144, #145, #155):
 * atomic publication through temp+rename, unique temp paths per writer,
 * healing rewrites of a corrupt address, the once-per-lifetime verification
 * memo and its eviction, and the conservative orphan sweep. Two properties are
 * new, both from Bazel's `DiskCacheClient`: the two-hex fanout layout and the
 * fsync of the temp file before the rename.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import { bytes, runPromise, sha256, text } from "./Crypto.ts"

const artifact = "shared-oversized-artifact-content"
const digest = sha256(bytes(artifact))
const blobPath = `.flows/objects/${digest.slice(0, 2)}/${digest}`

/**
 * An in-memory host filesystem with per-path instrumentation. Final state
 * alone cannot distinguish a dedupe skip from an unconditional rewrite, so the
 * read and write logs are what the memo cells assert on (issue #143).
 */
const memoryFs = (options: {
  readonly seed?: Record<string, string>
  readonly mtimes?: Record<string, number>
  readonly failRenameTo?: string
  readonly failReadOf?: string
  readonly failDirectoryRead?: boolean
  readonly supportsOpen?: boolean
} = {}) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(options.seed ?? {}).map(([path, content]) => [path, bytes(content)])
  )
  const directories = new Set<string>()
  const writes: Array<string> = []
  const reads: Array<string> = []
  const syncs: Array<string> = []
  let directoryReads = 0
  const fs = FileSystem.makeNoop({
    exists: ((path: string) => Effect.succeed(files.has(path))) as never,
    readFile: ((path: string) =>
      Effect.suspend(() => {
        reads.push(path)
        return files.has(path) && path !== options.failReadOf
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))
      })) as never,
    makeDirectory: ((path: string) =>
      Effect.sync(() => {
        directories.add(path)
      })) as never,
    readDirectory: ((directory: string) =>
      Effect.suspend(() => {
        directoryReads++
        if (options.failDirectoryRead === true) return Effect.fail(new Error("ENOENT: no objects directory"))
        const prefix = `${directory}/`
        return Effect.succeed(
          [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))
        )
      })) as never,
    stat: ((path: string) => {
      const mtime = options.mtimes?.[path]
      return mtime === undefined
        ? Effect.fail(new Error(`ENOENT: ${path}`))
        : Effect.succeed({ mtime: Option.some(new Date(mtime)) })
    }) as never,
    open: ((path: string) =>
      options.supportsOpen === true
        ? Effect.sync(() => ({
          sync: Effect.sync(() => {
            syncs.push(path)
          })
        }))
        : Effect.fail(new Error(`ENOTSUP: open ${path}`))) as never,
    writeFile: ((path: string, content: Uint8Array) =>
      Effect.sync(() => {
        writes.push(path)
        files.set(path, content)
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        if (to === options.failRenameTo) return Effect.fail(new Error(`EIO: ${to}`))
        const content = files.get(from)
        if (content === undefined) return Effect.fail(new Error(`ENOENT: ${from}`))
        files.set(to, content)
        files.delete(from)
        return Effect.void
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, directories, writes, reads, syncs, directoryReads: () => directoryReads, fs }
}

const store = (host: ReturnType<typeof memoryFs>, options?: ArtifactStore.FileSystemOptions) =>
  ArtifactStore.makeFileSystem(host.fs, options)

const tempsOf = (host: ReturnType<typeof memoryFs>) => [...host.files.keys()].filter((path) => path.includes(".tmp-"))

describe("content addressing and layout", () => {
  it("publishes under a two-hex fanout directory, not one flat directory", async () => {
    const host = memoryFs()
    const published = await runPromise(store(host).put(bytes(artifact)))
    expect(published).toBe(digest)
    expect(host.files.has(blobPath)).toBe(true)
    // The parent directory is created recursively before the temp write.
    expect(host.directories.has(`.flows/objects/${digest.slice(0, 2)}`)).toBe(true)
    // And the flat address the store used to publish at is gone for good.
    expect(host.files.has(`.flows/objects/${digest}`)).toBe(false)
  })

  it("honours a caller-supplied directory", async () => {
    const host = memoryFs()
    await runPromise(store(host, { directory: ".objects" }).put(bytes(artifact)))
    expect(host.files.has(`.objects/${digest.slice(0, 2)}/${digest}`)).toBe(true)
  })

  it("round-trips the bytes it stored", async () => {
    const host = memoryFs()
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(text(await runPromise(artifacts.get(digest)))).toBe(artifact)
  })
})

describe("atomic publication (issues #117, #131, #138)", () => {
  it("writes through a temp path and renames into place", async () => {
    const host = memoryFs()
    await runPromise(store(host).put(bytes(artifact)))
    expect(host.writes).toHaveLength(1)
    expect(host.writes[0]!.includes(".tmp-")).toBe(true)
    expect(tempsOf(host)).toEqual([])
  })

  it("gives two store instances distinct temp paths for one digest", async () => {
    // The cross-process shape: each instance's temp counter starts fresh,
    // exactly as two processes' counters both start at 0. Before the random
    // per-instance token, both wrote `<blob>.tmp-0`, one truncating open
    // clobbered the other's completed temp file, and the first rename
    // published torn bytes at the canonical content address (issue #131). The
    // latch pins that interleaving: neither writer may rename until both have
    // written their temp file.
    const host = memoryFs()
    const parked: Array<string> = []
    let release: (() => void) | undefined
    const bothWritten = new Promise<void>((resolve) => {
      release = resolve
    })
    const latched = FileSystem.makeNoop({
      ...host.fs,
      writeFile: ((path: string, content: Uint8Array) =>
        Effect.promise(async () => {
          parked.push(path)
          host.files.set(path, content)
          host.writes.push(path)
          if (parked.length >= 2) release!()
          await bothWritten
        })) as never
    })
    const exit = await runPromise(
      Effect.all(
        [
          ArtifactStore.makeFileSystem(latched).put(bytes(artifact)),
          ArtifactStore.makeFileSystem(latched).put(bytes(artifact))
        ],
        { concurrency: 2 }
      ).pipe(Effect.exit)
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(new Set(parked).size).toBe(2)
    expect(text(host.files.get(blobPath))).toBe(artifact)
  })

  it("removes the temp file when the publishing rename fails", async () => {
    const host = memoryFs({ failRenameTo: blobPath })
    const exit = await runPromise(store(host).put(bytes(artifact)).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(tempsOf(host)).toEqual([])
  })

  it("fsyncs the temp file before renaming it, where the host has writable handles", async () => {
    // Bazel's `DiskCacheClient.saveFile`: "fsync temp before we rename it to
    // avoid data loss in the case of machine crashes (the OS may reorder the
    // writes and the rename)".
    const host = memoryFs({ supportsOpen: true })
    await runPromise(store(host).put(bytes(artifact)))
    expect(host.syncs).toHaveLength(1)
    expect(host.syncs[0]!.includes(".tmp-")).toBe(true)
  })

  it("still publishes on a host with no writable file handles", async () => {
    // `BrowserFileSystem` fails `open` rather than pretending. Such a host
    // keeps the temp+rename atomicity and simply forgoes the durability bound.
    const host = memoryFs({ supportsOpen: false })
    await runPromise(store(host).put(bytes(artifact)))
    expect(host.syncs).toEqual([])
    expect(text(host.files.get(blobPath))).toBe(artifact)
  })
})

describe("verification and healing (issues #132, #143, #144, #145)", () => {
  it("leaves a healthy existing blob unwritten", async () => {
    const host = memoryFs({ seed: { [blobPath]: artifact } })
    await runPromise(store(host).put(bytes(artifact)))
    expect(host.writes).toEqual([])
    expect(tempsOf(host)).toEqual([])
  })

  it("heals a corrupt existing blob at the canonical address", async () => {
    const host = memoryFs({ seed: { [blobPath]: "torn-partial-bytes" } })
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(text(host.files.get(blobPath))).toBe(artifact)
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
    expect(text(await runPromise(artifacts.get(digest)))).toBe(artifact)
  })

  it("rewrites an existing blob the host cannot read back", async () => {
    const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
    await runPromise(store(host).put(bytes(artifact)))
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
  })

  it("verifies an existing blob once per store lifetime, not once per put", async () => {
    const host = memoryFs({ seed: { [blobPath]: artifact } })
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    await runPromise(artifacts.put(bytes(artifact)))
    expect(host.reads.filter((path) => path === blobPath)).toHaveLength(1)
    expect(host.writes).toEqual([])
  })

  it("trusts its own atomic publication on the next put of the digest", async () => {
    const host = memoryFs()
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    await runPromise(artifacts.put(bytes(artifact)))
    expect(host.reads.filter((path) => path === blobPath)).toHaveLength(0)
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
  })

  it("evicts the memo when a read finds corruption, so the next put heals", async () => {
    const host = memoryFs()
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    host.files.set(blobPath, bytes("torn-partial-bytes"))
    const refused = await runPromise(artifacts.get(digest).pipe(Effect.exit))
    expect(Exit.isFailure(refused)).toBe(true)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
    expect(text(await runPromise(artifacts.get(digest)))).toBe(artifact)
  })

  it("evicts the memo when the blob cannot be read", async () => {
    const host = memoryFs({ failReadOf: blobPath })
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(Exit.isFailure(await runPromise(artifacts.get(digest).pipe(Effect.exit)))).toBe(true)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
  })

  it("evicts the memo when the blob vanishes", async () => {
    const host = memoryFs()
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    host.files.delete(blobPath)
    expect(Exit.isFailure(await runPromise(artifacts.get(digest).pipe(Effect.exit)))).toBe(true)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
  })

  it("bounds the memo, re-verifying the digest it evicted (issue #155)", async () => {
    // The memo is a bounded LRU, so a long-lived host cannot grow it for the
    // process lifetime. Correctness never depends on membership: an evicted
    // digest simply re-pays its verification read.
    const host = memoryFs()
    const artifacts = store(host)
    const first = bytes("artifact-0")
    await runPromise(artifacts.put(first))
    // 4096 further distinct artifacts push the first one out of the LRU.
    await runPromise(
      Effect.forEach(
        Array.from({ length: 4096 }, (_unused, index) => bytes(`filler-${index}`)),
        (payload) => artifacts.put(payload),
        { discard: true }
      )
    )
    const firstPath = `.flows/objects/${sha256(first).slice(0, 2)}/${sha256(first)}`
    const before = host.reads.filter((path) => path === firstPath).length
    await runPromise(artifacts.put(first))
    // The evicted digest is verified again rather than trusted.
    expect(host.reads.filter((path) => path === firstPath).length).toBe(before + 1)
  })
})

describe("the orphan sweep (issue #138)", () => {
  const stale = `.flows/objects/aa/old.tmp-dead-0`
  const fresh = `.flows/objects/aa/live.tmp-live-0`

  it("sweeps stale orphans on first put, keeps fresh temps, and sweeps once", async () => {
    const now = Date.now()
    const host = memoryFs({
      seed: { [stale]: "torn", [fresh]: "in-flight" },
      mtimes: { [stale]: now - 2 * 60 * 60 * 1000, [fresh]: now }
    })
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(host.files.has(stale)).toBe(false)
    expect(host.files.has(fresh)).toBe(true)
    await runPromise(artifacts.put(bytes("a second artifact body")))
    expect(host.directoryReads()).toBe(1)
  })

  it("keeps a temp file whose age cannot be measured", async () => {
    // `stat` failing says nothing about the writer's liveness, so the
    // conservative sweep never deletes what it cannot age.
    const host = memoryFs({ seed: { [`.flows/objects/aa/unknown.tmp-mystery-0`]: "unknown-age" } })
    await runPromise(store(host).put(bytes(artifact)))
    expect(host.files.has(`.flows/objects/aa/unknown.tmp-mystery-0`)).toBe(true)
  })

  it("survives a directory it cannot list", async () => {
    const host = memoryFs({ failDirectoryRead: true })
    await runPromise(store(host).put(bytes(artifact)))
    expect(text(host.files.get(blobPath))).toBe(artifact)
  })
})

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("reads, probes, and refusals", () => {
  it("reports a typed miss for an address it does not hold", async () => {
    const host = memoryFs()
    const exit = await runPromise(store(host).get(digest).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
  })

  it("reports typed corruption when the bytes no longer hash to the address", async () => {
    const host = memoryFs({ seed: { [blobPath]: "torn-partial-bytes" } })
    const exit = await runPromise(store(host).get(digest).pipe(Effect.exit))
    const error = errorOf(exit) as ArtifactStore.ArtifactCorruption
    expect(error._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
    expect(error.recordedDigest).toBe(digest)
    expect(error.measuredDigest).toBe(sha256(bytes("torn-partial-bytes")))
  })

  it("surfaces a host refusal as an ordinary store failure, not corruption", async () => {
    const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
    const exit = await runPromise(store(host).get(digest).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
  })

  it.each([
    ["an empty string", ""],
    ["a path separator", "ab/cd"],
    ["a windows separator", "ab\\cd"],
    ["the current directory", "."],
    ["the parent directory", ".."]
  ])("refuses %s as a content address", async (_label, candidate) => {
    const host = memoryFs()
    const artifacts = store(host)
    const exits: Array<Exit.Exit<unknown, unknown>> = [
      await runPromise(artifacts.get(candidate).pipe(Effect.exit)),
      await runPromise(artifacts.has(candidate).pipe(Effect.exit))
    ]
    for (const exit of exits) {
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_digest")
    }
  })

  it("answers `has` from the canonical address", async () => {
    const host = memoryFs()
    const artifacts = store(host)
    expect(await runPromise(artifacts.has(digest))).toBe(false)
    await runPromise(artifacts.put(bytes(artifact)))
    expect(await runPromise(artifacts.has(digest))).toBe(true)
  })

  it("returns a deduplicated subset of the probed digests", async () => {
    const host = memoryFs()
    const artifacts = store(host)
    await runPromise(artifacts.put(bytes(artifact)))
    const absent = sha256(bytes("never stored"))
    const missing = await runPromise(artifacts.findMissing([digest, absent, absent, digest]))
    expect(missing).toEqual([absent])
  })
})

describe("layers", () => {
  it("layerFileSystem builds the store from the FileSystem tag", async () => {
    const host = memoryFs()
    const published = await runPromise(
      Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
        Effect.provide(
          ArtifactStore.layerFileSystem().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem)(host.fs)))
        )
      )
    )
    expect(published).toBe(digest)
    expect(host.files.has(blobPath)).toBe(true)
  })
})
