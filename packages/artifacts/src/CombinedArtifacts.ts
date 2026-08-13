/**
 * Two artifact tiers composed into one: local first, remote second, with
 * write-back into the local tier.
 *
 * This is the shape of Bazel's `CombinedCache`
 * (`reference/bazel/.../remote/CombinedCache.java`): a read consults the disk
 * cache, falls back to the remote cache only on a miss, and *uploads what it
 * found back into the disk cache* so the next read is local
 * (`downloadActionResultFromRemote`, lines 230-303). A write goes to both.
 *
 * Deviation from Bazel: it threads a per-request `ReadCachePolicy` /
 * `WriteCachePolicy` through every call so a spawn can opt a tier out. We have
 * no such policy object, and the analogous dial — Bazel's
 * `RemoteOutputChecker` download policy — is deliberately out of scope and
 * ticketed (`.smithers/tickets/remote-cache-download-policy.md`). Composing
 * only the local tier is how a caller opts out today.
 *
 * @since 0.1.0
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ArtifactStore from "./ArtifactStore.ts"

/**
 * The two tiers to compose.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The fast, machine-local tier. Every read tries this one first. */
  readonly local: ArtifactStore.Service
  /** The shared tier. Consulted only on a local miss; written through on put. */
  readonly remote: ArtifactStore.Service
}

/**
 * Composes a local and a remote artifact store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): ArtifactStore.Service => {
  const { local, remote } = options
  /**
   * In-flight uploads, keyed by digest. Two settles in one process that spill
   * the same artifact would otherwise both push the same bytes over the
   * network; the second joins the first's `Deferred` instead. The map holds
   * only in-flight work — the entry is removed before the deferred is
   * completed, so a later `put` of the same digest starts a fresh upload
   * rather than replaying a stale outcome.
   */
  const uploads = new Map<string, Deferred.Deferred<ArtifactStore.Digest, ArtifactStore.ArtifactStoreError>>()
  const uploadOnce = (digest: ArtifactStore.Digest, bytes: Uint8Array) =>
    Effect.gen(function*() {
      const joined = uploads.get(digest)
      if (joined !== undefined) return yield* Deferred.await(joined)
      const deferred = yield* Deferred.make<ArtifactStore.Digest, ArtifactStore.ArtifactStoreError>()
      uploads.set(digest, deferred)
      const exit = yield* Effect.exit(remote.put(bytes))
      uploads.delete(digest)
      yield* Deferred.done(deferred, exit)
      return yield* exit
    })

  const put: ArtifactStore.Service["put"] = Effect.fn("CombinedArtifacts.put")((bytes: Uint8Array) =>
    Effect.gen(function*() {
      // Local first, and its digest is the answer: the local tier is the one
      // this machine's replays resolve against, so a remote tier that is down
      // must not stop an artifact from being recorded locally.
      const digest = yield* local.put(bytes)
      // Which means the upload is opportunistic, and a refusal is dropped
      // rather than propagated. Failing here would fail whatever produced the
      // bytes — a step's `settle`, say — because a *cache* was unreachable,
      // which is the opposite of the line above. Nothing depends on this
      // upload: what actually guarantees a shared cache entry's blobs are
      // durable is the publication protocol's `findMissing` → upload →
      // confirm, run before the entry is published. A dropped upload here
      // costs that protocol one re-upload, never correctness.
      yield* Effect.ignore(uploadOnce(digest, bytes))
      return digest
    })
  )

  const get: ArtifactStore.Service["get"] = Effect.fn("CombinedArtifacts.get")((digest: string) =>
    local.get(digest).pipe(
      // A local miss AND local corruption both fall through to the remote
      // tier. Corruption is the interesting one: the write-back below hands
      // the correct bytes to `local.put`, whose own digest verification finds
      // the mismatched blob and atomically rewrites it, so a read-through
      // heals a corrupt local address instead of failing on it forever.
      Effect.catchTags({
        "@smthrs/artifacts-next/ArtifactMissing": () => Effect.void,
        "@smthrs/artifacts-next/ArtifactCorruption": () => Effect.void
      }),
      Effect.flatMap((cached) =>
        cached === undefined
          ? Effect.tap(remote.get(digest), (bytes) => local.put(bytes))
          : Effect.succeed(cached)
      )
    )
  )

  const has: ArtifactStore.Service["has"] = Effect.fn("CombinedArtifacts.has")((digest: string) =>
    Effect.flatMap(local.has(digest), (present) => present ? Effect.succeed(true) : remote.has(digest))
  )

  const findMissing: ArtifactStore.Service["findMissing"] = Effect.fn("CombinedArtifacts.findMissing")(
    (digests: Iterable<string>) =>
      // Missing means missing from BOTH tiers, and the remote probe is asked
      // only about what the local tier could not answer — one network round
      // trip, over the smallest possible set. The result stays a subset of the
      // input because each stage filters the previous stage's output.
      Effect.flatMap(local.findMissing(digests), (missingLocally) =>
        missingLocally.length === 0 ? Effect.succeed(missingLocally) : remote.findMissing(missingLocally))
  )

  return { put, get, has, findMissing }
}

/**
 * Provides a combined artifact store as the `ArtifactStore` tag.
 *
 * Both tiers are supplied as *effects* rather than layers because they inhabit
 * the same tag: composing two `Layer<ArtifactStore>` would just shadow one
 * with the other. Pair `ArtifactStore.makeFileSystem` (wrapped in
 * `Effect.sync`) or `Effect.map(FileSystem.FileSystem, ...)` with
 * `RemoteArtifacts.make`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = <EL, RL, ER, RR>(options: {
  readonly local: Effect.Effect<ArtifactStore.Service, EL, RL>
  readonly remote: Effect.Effect<ArtifactStore.Service, ER, RR>
}): Layer.Layer<ArtifactStore.ArtifactStore, EL | ER, RL | RR> =>
  Layer.effect(ArtifactStore.ArtifactStore)(
    Effect.map(
      Effect.all({ local: options.local, remote: options.remote }),
      make
    )
  )
