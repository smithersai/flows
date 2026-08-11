/**
 * Local-first, remote-second, with write-back — the shape of Bazel's
 * `CombinedCache` (`reference/bazel/.../remote/CombinedCache.java`).
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as CombinedArtifacts from "../src/CombinedArtifacts.ts"
import { bytes, runPromise, sha256, text } from "./Crypto.ts"

const artifact = "an artifact that travels"
const digest = sha256(bytes(artifact))

/** A memory store with a call log, so tier routing is observable. */
const countingMemory = () => {
  const inner = ArtifactStore.makeMemory()
  const calls: Array<string> = []
  const store: ArtifactStore.Service = {
    put: (payload) => Effect.tap(inner.put(payload), () => Effect.sync(() => calls.push("put"))),
    get: (address) => Effect.tap(inner.get(address), () => Effect.sync(() => calls.push("get"))),
    has: (address) => Effect.tap(inner.has(address), () => Effect.sync(() => calls.push("has"))),
    findMissing: (addresses) =>
      Effect.tap(inner.findMissing(addresses), () => Effect.sync(() => calls.push("findMissing")))
  }
  return { calls, store, inner }
}

describe("reads", () => {
  it("answers from the local tier without touching the remote one", async () => {
    const local = countingMemory()
    const remote = countingMemory()
    const combined = CombinedArtifacts.make({ local: local.store, remote: remote.store })
    await runPromise(local.store.put(bytes(artifact)))
    expect(text(await runPromise(combined.get(digest)))).toBe(artifact)
    expect(remote.calls).toEqual([])
  })

  it("falls through to the remote tier and writes back locally", async () => {
    const local = countingMemory()
    const remote = countingMemory()
    const combined = CombinedArtifacts.make({ local: local.store, remote: remote.store })
    await runPromise(remote.store.put(bytes(artifact)))
    expect(text(await runPromise(combined.get(digest)))).toBe(artifact)
    // The write-back means the next read is local.
    expect(await runPromise(local.store.has(digest))).toBe(true)
    const remoteReads = remote.calls.filter((call) => call === "get").length
    expect(text(await runPromise(combined.get(digest)))).toBe(artifact)
    expect(remote.calls.filter((call) => call === "get")).toHaveLength(remoteReads)
  })

  it("heals a corrupt local address from the remote tier", async () => {
    // Local corruption falls through exactly like a miss: the write-back hands
    // the correct bytes to `local.put`, whose own verification finds the
    // mismatched blob and rewrites it.
    const corrupt = ArtifactStore.makeNoop({
      get: () =>
        Effect.fail(
          new ArtifactStore.ArtifactCorruption({
            code: "artifact_corruption",
            recordedDigest: digest,
            measuredDigest: sha256(bytes("torn"))
          })
        ),
      put: ArtifactStore.makeMemory().put
    })
    const remote = countingMemory()
    await runPromise(remote.store.put(bytes(artifact)))
    const combined = CombinedArtifacts.make({ local: corrupt, remote: remote.store })
    expect(text(await runPromise(combined.get(digest)))).toBe(artifact)
  })

  it("propagates a remote miss", async () => {
    const combined = CombinedArtifacts.make({
      local: ArtifactStore.makeMemory(),
      remote: ArtifactStore.makeMemory()
    })
    const exit = await runPromise(combined.get(digest).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("writes", () => {
  it("stores locally and uploads to the shared tier", async () => {
    const local = countingMemory()
    const remote = countingMemory()
    const combined = CombinedArtifacts.make({ local: local.store, remote: remote.store })
    expect(await runPromise(combined.put(bytes(artifact)))).toBe(digest)
    expect(await runPromise(local.store.has(digest))).toBe(true)
    expect(await runPromise(remote.store.has(digest))).toBe(true)
  })

  it("deduplicates concurrent uploads of one digest", async () => {
    const local = countingMemory()
    const uploads: Array<string> = []
    const gate = await Effect.runPromise(Deferred.make<void>())
    const remote = ArtifactStore.makeNoop({
      put: (payload) =>
        Effect.gen(function*() {
          uploads.push("put")
          yield* Deferred.await(gate)
          return yield* ArtifactStore.makeMemory().put(payload)
        })
    })
    const combined = CombinedArtifacts.make({ local: local.store, remote })
    const running = runPromise(
      Effect.all([combined.put(bytes(artifact)), combined.put(bytes(artifact))], { concurrency: 2 })
    )
    await Effect.runPromise(Deferred.succeed(gate, undefined))
    expect(await running).toEqual([digest, digest])
    // The second caller joined the first upload instead of repeating it.
    expect(uploads).toHaveLength(1)
  })

  it("starts a fresh upload once the in-flight one has settled", async () => {
    const uploads: Array<string> = []
    const remote = ArtifactStore.makeNoop({
      put: (payload) =>
        Effect.gen(function*() {
          uploads.push("put")
          return yield* ArtifactStore.makeMemory().put(payload)
        })
    })
    const combined = CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
    await runPromise(combined.put(bytes(artifact)))
    await runPromise(combined.put(bytes(artifact)))
    expect(uploads).toHaveLength(2)
  })
})

describe("probes", () => {
  it("answers `has` locally, then remotely", async () => {
    const remote = countingMemory()
    await runPromise(remote.store.put(bytes(artifact)))
    const combined = CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote: remote.store })
    expect(await runPromise(combined.has(digest))).toBe(true)
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(bytes(artifact)))
    const localFirst = CombinedArtifacts.make({ local, remote: remote.store })
    const before = remote.calls.length
    expect(await runPromise(localFirst.has(digest))).toBe(true)
    expect(remote.calls).toHaveLength(before)
  })

  it("probes the remote tier only about what the local tier lacks", async () => {
    const other = sha256(bytes("another artifact"))
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(bytes(artifact)))
    const remote = countingMemory()
    await runPromise(remote.store.put(bytes("another artifact")))
    const combined = CombinedArtifacts.make({ local, remote: remote.store })
    expect(await runPromise(combined.findMissing([digest, other]))).toEqual([])
  })

  it("skips the remote round trip when the local tier holds everything", async () => {
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(bytes(artifact)))
    const remote = countingMemory()
    const combined = CombinedArtifacts.make({ local, remote: remote.store })
    expect(await runPromise(combined.findMissing([digest]))).toEqual([])
    expect(remote.calls).toEqual([])
  })

  it("reports what neither tier holds", async () => {
    const combined = CombinedArtifacts.make({
      local: ArtifactStore.makeMemory(),
      remote: ArtifactStore.makeMemory()
    })
    expect(await runPromise(combined.findMissing([digest]))).toEqual([digest])
  })
})

describe("layer", () => {
  it("builds both tiers from effects and provides one tag", async () => {
    const remote = ArtifactStore.makeMemory()
    const published = await runPromise(
      Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.put(bytes(artifact))).pipe(
        Effect.provide(
          CombinedArtifacts.layer({
            local: Effect.sync(ArtifactStore.makeMemory),
            remote: Effect.succeed(remote)
          })
        )
      )
    )
    expect(published).toBe(digest)
    expect(await runPromise(remote.has(digest))).toBe(true)
  })
})
