/**
 * The memory and no-op stores: the browser/test tier, and the honest refusal
 * a composition gets when it has no artifact store at all.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import { bytes, runPromise, sha256, text } from "./Crypto.ts"

const artifact = "an in-memory artifact"
const digest = sha256(bytes(artifact))

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("makeMemory", () => {
  it("round-trips bytes under their own digest", async () => {
    const artifacts = ArtifactStore.makeMemory()
    expect(await runPromise(artifacts.put(bytes(artifact)))).toBe(digest)
    expect(text(await runPromise(artifacts.get(digest)))).toBe(artifact)
    expect(await runPromise(artifacts.has(digest))).toBe(true)
  })

  it("is immune to a caller mutating the array it put", async () => {
    // The map is keyed by the digest measured at accept time, so an aliased
    // input array would let a later caller mutation corrupt the stored
    // content for its address. `put` stores a defensive copy instead.
    const artifacts = ArtifactStore.makeMemory()
    const input = bytes(artifact)
    const stored = await runPromise(artifacts.put(input))
    input[0] = 0x58
    expect(text(await runPromise(artifacts.get(stored)))).toBe(artifact)
  })

  it("is immune to a caller mutating the array it got", async () => {
    // `get` hands out a copy for the same reason: the stored array must never
    // be reachable through a reference a caller can still write to.
    const artifacts = ArtifactStore.makeMemory()
    await runPromise(artifacts.put(bytes(artifact)))
    const first = await runPromise(artifacts.get(digest))
    first[0] = 0x58
    expect(text(await runPromise(artifacts.get(digest)))).toBe(artifact)
  })

  it("reports a typed miss for an address it never accepted", async () => {
    const artifacts = ArtifactStore.makeMemory()
    const exit = await runPromise(artifacts.get(digest).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts-next/ArtifactMissing")
    expect(await runPromise(artifacts.has(digest))).toBe(false)
  })

  it("refuses an address that is not usable as one", async () => {
    const exit = await runPromise(ArtifactStore.makeMemory().get("").pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_digest")
  })

  it("returns a deduplicated subset from findMissing", async () => {
    const artifacts = ArtifactStore.makeMemory()
    await runPromise(artifacts.put(bytes(artifact)))
    const absent = sha256(bytes("never stored"))
    expect(await runPromise(artifacts.findMissing([digest, absent, absent]))).toEqual([absent])
  })

  it("layerMemory provides it under the tag", async () => {
    const published = await runPromise(
      Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
        Effect.provide(ArtifactStore.layerMemory)
      )
    )
    expect(published).toBe(digest)
  })
})

describe("makeNoop", () => {
  it("fails every operation as unavailable", async () => {
    const artifacts = ArtifactStore.makeNoop()
    const exits: Array<Exit.Exit<unknown, unknown>> = [
      await runPromise(artifacts.put(bytes(artifact)).pipe(Effect.exit)),
      await runPromise(artifacts.get(digest).pipe(Effect.exit)),
      await runPromise(artifacts.has(digest).pipe(Effect.exit)),
      await runPromise(artifacts.findMissing([digest]).pipe(Effect.exit))
    ]
    for (const exit of exits) {
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
    }
  })

  it("takes per-method overrides", async () => {
    const artifacts = ArtifactStore.makeNoop({ has: () => Effect.succeed(true) })
    expect(await runPromise(artifacts.has(digest))).toBe(true)
  })

  it("layerNoop provides it under the tag", async () => {
    const exit = await runPromise(
      Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.has(digest)).pipe(
        Effect.provide(ArtifactStore.layerNoop()),
        Effect.exit
      )
    )
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
  })
})
