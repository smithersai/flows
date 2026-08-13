/**
 * The two-tier artifact protocol: publish before the entry, fetch on demand
 * after it (issue #172).
 *
 * The ordering is Bazel's REAPI constraint
 * (`reference/bazel/.../remote/UploadManifest.java:630-633`): every blob a
 * result references must be present before the result itself is published, or
 * a sibling machine gets a hit it cannot materialize.
 */
import * as ArtifactStore from "@smthrs/artifacts-next/ArtifactStore"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CachePublication from "../src/internal/CachePublication.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const encoder = new TextEncoder()
const payload = encoder.encode("a referenced artifact")
const digest = sha256(payload)

const evidenceFor = (outputs: unknown): StepBoundary.BoundaryEvidence => ({
  declaredOutputs: outputs,
  diffIdentity: "diff"
})

const referenced = evidenceFor({ outputs: [{ path: "artifact.bin", digest, sizeBytes: payload.length }] })

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("referencedDigests", () => {
  it("names the digests evidence references rather than inlines", () => {
    expect(StepBoundary.referencedDigests(referenced)).toEqual([digest])
  })

  it("ignores inline payloads, removals, and legacy rows", () => {
    // An inline row carries its bytes with it, a null digest records a removal,
    // and a round-7 legacy row has no digest at all: none of the three
    // references the artifact store.
    const mixed = evidenceFor({
      outputs: [
        { path: "inline.txt", digest: sha256(encoder.encode("small")), content: "c21hbGw=" },
        { path: "removed.txt", digest: null },
        { path: "legacy.txt", content: "bGVnYWN5" },
        { path: "artifact.bin", digest, sizeBytes: payload.length }
      ]
    })
    expect(StepBoundary.referencedDigests(mixed)).toEqual([digest])
  })

  it("names nothing for evidence recorded by a foreign boundary", () => {
    expect(StepBoundary.referencedDigests(evidenceFor({ paths: ["output.txt"] }))).toEqual([])
  })
})

describe("makeLocal", () => {
  it("publishes nothing and fetches nothing", async () => {
    const local = ArtifactSync.makeLocal()
    await runPromise(local.publish([digest]))
    expect(await runPromise(local.hydrate([digest]))).toBe(false)
    // Nothing to fetch is trivially satisfied.
    expect(await runPromise(local.hydrate([]))).toBe(true)
  })
})

describe("publish", () => {
  const tiers = () => {
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    return { local, remote, sync: ArtifactSync.make({ local, remote }) }
  }

  it("does nothing when the evidence references nothing", async () => {
    const { remote, sync } = tiers()
    await runPromise(sync.publish([]))
    expect(await runPromise(remote.findMissing([digest]))).toEqual([digest])
  })

  it("probes, uploads what is missing, and confirms", async () => {
    const { local, remote, sync } = tiers()
    await runPromise(local.put(payload))
    await runPromise(sync.publish([digest]))
    expect(await runPromise(remote.has(digest))).toBe(true)
  })

  it("uploads nothing the shared tier already holds", async () => {
    const local = ArtifactStore.makeMemory()
    const uploads: Array<string> = []
    const inner = ArtifactStore.makeMemory()
    await runPromise(inner.put(payload))
    const remote = ArtifactStore.makeNoop({
      findMissing: inner.findMissing,
      put: (bytes) => {
        uploads.push("put")
        return inner.put(bytes)
      }
    })
    await runPromise(ArtifactSync.make({ local, remote }).publish([digest]))
    expect(uploads).toEqual([])
  })

  it("fails when the shared tier cannot be probed", async () => {
    const sync = ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote: ArtifactStore.makeNoop() })
    const exit = await runPromise(sync.publish([digest]).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).code).toBe("artifact_publication_failed")
  })

  it("fails when this host cannot read the artifact it recorded", async () => {
    const { remote } = tiers()
    const sync = ArtifactSync.make({ local: ArtifactStore.makeMemory(), remote })
    const exit = await runPromise(sync.publish([digest]).pipe(Effect.exit))
    const failure = errorOf(exit) as ArtifactSync.ArtifactPublicationFailed
    expect(failure.message).toContain("cannot read the artifact it recorded")
    expect(failure.digests).toEqual([digest])
  })

  it("fails when the shared tier refuses the upload", async () => {
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(payload))
    const remote = ArtifactStore.makeNoop({ findMissing: (digests) => Effect.succeed([...digests]) })
    const exit = await runPromise(ArtifactSync.make({ local, remote }).publish([digest]).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).message).toContain("refused an upload")
  })

  it("fails when the confirming re-probe cannot be made", async () => {
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(payload))
    let probes = 0
    const remote = ArtifactStore.makeNoop({
      findMissing: (digests) =>
        Effect.suspend(() => {
          probes++
          // The upload probe answers; the confirming re-probe does not.
          return probes === 1
            ? Effect.succeed([...digests])
            : Effect.fail(
              new ArtifactStore.ArtifactStoreError({ code: "transport_failed", message: "gateway timeout" })
            )
        }),
      put: () => Effect.succeed(digest as never)
    })
    const exit = await runPromise(ArtifactSync.make({ local, remote }).publish([digest]).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).message).toContain("refused a probe")
  })

  it("fails when the shared tier did not retain what it accepted", async () => {
    // A tier that accepts an upload but does not durably store it is exactly
    // the state that makes a published entry unreplayable, so the confirming
    // re-probe is not paranoia.
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(payload))
    const remote = ArtifactStore.makeNoop({
      findMissing: (digests) => Effect.succeed([...digests]),
      put: () => Effect.succeed(digest as never)
    })
    const exit = await runPromise(ArtifactSync.make({ local, remote }).publish([digest]).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactSync.ArtifactPublicationFailed).message).toContain("did not retain")
  })
})

describe("hydrate", () => {
  it("reports satisfaction when everything is already local", async () => {
    const local = ArtifactStore.makeMemory()
    await runPromise(local.put(payload))
    const sync = ArtifactSync.make({ local, remote: ArtifactStore.makeNoop() })
    expect(await runPromise(sync.hydrate([digest]))).toBe(true)
  })

  it("fetches what is missing and writes it back locally", async () => {
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    await runPromise(remote.put(payload))
    expect(await runPromise(ArtifactSync.make({ local, remote }).hydrate([digest]))).toBe(true)
    expect(await runPromise(local.has(digest))).toBe(true)
  })

  it("reports failure — never fails the run — when the shared tier cannot serve it", async () => {
    const sync = ArtifactSync.make({
      local: ArtifactStore.makeMemory(),
      remote: ArtifactStore.makeMemory()
    })
    expect(await runPromise(sync.hydrate([digest]))).toBe(false)
  })

  it("reports failure when the local tier cannot even be probed", async () => {
    const sync = ArtifactSync.make({ local: ArtifactStore.makeNoop(), remote: ArtifactStore.makeMemory() })
    expect(await runPromise(sync.hydrate([digest]))).toBe(false)
  })
})

describe("layers", () => {
  it("layerLocal provides the single-tier protocol", async () => {
    expect(
      await runPromise(
        Effect.flatMap(ArtifactSync.ArtifactSync, (sync) => sync.hydrate([digest])).pipe(
          Effect.provide(ArtifactSync.layerLocal)
        )
      )
    ).toBe(false)
  })

  it("layer takes the local tier from the ArtifactStore tag", async () => {
    const remote = ArtifactStore.makeMemory()
    await runPromise(remote.put(payload))
    const hydrated = await runPromise(
      Effect.flatMap(ArtifactSync.ArtifactSync, (sync) => sync.hydrate([digest])).pipe(
        Effect.provide(ArtifactSync.layer(Effect.succeed(remote))),
        Effect.provide(ArtifactStore.layerMemory)
      )
    )
    expect(hydrated).toBe(true)
  })
})

describe("CachePublication", () => {
  it("publishes nothing for absent evidence and for evidence that references nothing", async () => {
    await runPromise(CachePublication.publishArtifacts(undefined))
    await runPromise(CachePublication.publishArtifacts(evidenceFor({ paths: [] })))
  })

  it("defaults to the single-tier protocol when no ArtifactSync is configured", async () => {
    // This is what keeps a purely local composition free of remote-cache
    // machinery: publishing is a no-op and hydration reports nothing arrived.
    await runPromise(CachePublication.publishArtifacts(referenced))
    expect(await runPromise(CachePublication.hydrateArtifacts(referenced))).toBe(false)
  })

  it("routes referenced digests to the configured protocol", async () => {
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    await runPromise(local.put(payload))
    await runPromise(
      CachePublication.publishArtifacts(referenced).pipe(
        Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote }))
      )
    )
    expect(await runPromise(remote.has(digest))).toBe(true)
  })

  it("hydrates through the configured protocol", async () => {
    const local = ArtifactStore.makeMemory()
    const remote = ArtifactStore.makeMemory()
    await runPromise(remote.put(payload))
    const hydrated = await runPromise(
      CachePublication.hydrateArtifacts(referenced).pipe(
        Effect.provideService(ArtifactSync.ArtifactSync, ArtifactSync.make({ local, remote }))
      )
    )
    expect(hydrated).toBe(true)
  })

  it("reports nothing to hydrate for evidence that references nothing", async () => {
    expect(await runPromise(CachePublication.hydrateArtifacts(evidenceFor({ paths: [] })))).toBe(false)
  })

  it("classifies only a missing artifact as fetchable", () => {
    const missing = new StepBoundary.MissingArtifact({ code: "missing_artifact", path: "a.bin", digest })
    expect(CachePublication.replayMissingArtifact(Cause.fail(missing))).toBe(missing)
    expect(
      CachePublication.replayMissingArtifact(
        Cause.fail(new StepBoundary.UnsupportedBoundary({ code: "unsupported_boundary", message: "EIO" }))
      )
    ).toBeUndefined()
    expect(CachePublication.replayMissingArtifact(Cause.die("boom"))).toBeUndefined()
  })
})
