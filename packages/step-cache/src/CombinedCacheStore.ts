/**
 * Two step-result tiers composed into one: local first, remote second, with
 * write-back into the local SQL store.
 *
 * The shape is Bazel's `CombinedCache.downloadActionResult`
 * (`reference/bazel/.../remote/CombinedCache.java`, lines 230-303): consult the
 * disk cache, fall back to the remote cache only on a miss, and write what the
 * remote returned back into the disk cache so the next lookup is local.
 *
 * **Publication order is the caller's job, not this store's.** A cache entry
 * must never be observable in the shared tier while an artifact it references
 * is missing from the shared artifact tier — Bazel's REAPI ordering constraint
 * at `UploadManifest.java:630-633`, stated there as "action results may fail to
 * validate server-side if they are accessed before all blobs they refer to are
 * present". `@smthrs/engine-store`'s `ArtifactSync` enforces it around
 * `put`. This module cannot: it does not know what an entry references.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as CacheStore from "./CacheStore.ts"

/**
 * The two tiers to compose.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The machine-local, durable tier. Every lookup tries this one first. */
  readonly local: CacheStore.Service
  /** The shared tier. Consulted only on a local miss; written through on put. */
  readonly remote: CacheStore.Service
}

/**
 * Composes a local and a remote cache store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): CacheStore.Service => {
  const { local, remote } = options

  const get: CacheStore.Service["get"] = Effect.fn("CombinedCacheStore.get")((keyDigest: string) =>
    Effect.gen(function*() {
      const cached = yield* local.get(keyDigest)
      if (Option.isSome(cached)) return cached
      const shared = yield* remote.get(keyDigest)
      if (Option.isNone(shared)) return shared
      // Write-back, exactly as `downloadActionResultFromRemote` does: the
      // shared entry becomes a local row so this machine's next lookup — and
      // every sibling run on it — is a local hit. The local `put` is
      // insert-or-nothing, so a row that landed concurrently wins and the
      // write-back is a no-op; the entry this caller returns is still the one
      // it read.
      yield* local.put(shared.value)
      return shared
    })
  )

  const put: CacheStore.Service["put"] = Effect.fn("CombinedCacheStore.put")((entry: CacheStore.CacheEntry) =>
    Effect.gen(function*() {
      // Local first, and the local outcome is the answer: first-writer-wins
      // conflict detection is what drives the `Inconsistency` receiver, and it
      // has to be decided against the durable row this machine will actually
      // replay from.
      const outcome = yield* local.put(entry)
      // A local `Conflict` means this machine already holds a *different*
      // result under the key. Publishing to the shared tier anyway would push
      // a result the caller is about to fail the run over.
      if (outcome._tag === "Conflict") return outcome
      yield* remote.put(entry)
      return outcome
    })
  )

  const evict: CacheStore.Service["evict"] = Effect.fn("CombinedCacheStore.evict")((keyDigest, evictOptions) =>
    // Eviction is deliberately local-only. Every eviction in the engine is a
    // *this host observed this row to be poison* judgement — a stale read set,
    // corrupt evidence this host could not materialize — and none of those
    // observations generalize to the shared tier, where another machine may
    // hold the artifacts this one lost. Reclaiming shared entries is an
    // explicit release verb (`docs/specs/Concepts/Reconciliation.md`) and is
    // ticketed (`.smithers/tickets/cas-garbage-collection.md`), never a side
    // effect of one host's failed replay.
    local.evict(keyDigest, evictOptions)
  )

  return { get, put, evict }
}

/**
 * Provides a combined cache store as the `CacheStore` tag.
 *
 * Both tiers are supplied as *effects* rather than layers because they inhabit
 * the same tag: composing two `Layer<CacheStore>` would just shadow one with
 * the other.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = <EL, RL, ER, RR>(options: {
  readonly local: Effect.Effect<CacheStore.Service, EL, RL>
  readonly remote: Effect.Effect<CacheStore.Service, ER, RR>
}): Layer.Layer<CacheStore.CacheStore, EL | ER, RL | RR> =>
  Layer.effect(CacheStore.CacheStore)(
    Effect.map(Effect.all({ local: options.local, remote: options.remote }), make)
  )
