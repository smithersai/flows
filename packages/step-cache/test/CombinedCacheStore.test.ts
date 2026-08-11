/**
 * Local-first, remote-second, with write-back into the local SQL store — the
 * shape of `CombinedCache.downloadActionResult`
 * (`reference/bazel/.../remote/CombinedCache.java`, lines 230-303).
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as CacheStore from "../src/CacheStore.ts"
import * as CombinedCacheStore from "../src/CombinedCacheStore.ts"

const entry: CacheStore.CacheEntry = {
  keyDigest: "key-digest",
  result: { ok: true },
  meta: {},
  createdAtMs: 7,
  recordedRunId: "run-1",
  recordedEventSeq: 3
}

/** A first-writer-wins in-memory tier with a call log. */
const tier = (options: { readonly putOutcome?: CacheStore.PutResult } = {}) => {
  const rows = new Map<string, CacheStore.CacheEntry>()
  const calls: Array<string> = []
  const store: CacheStore.Service = {
    get: (keyDigest) =>
      Effect.sync(() => {
        calls.push("get")
        const row = rows.get(keyDigest)
        return row === undefined ? Option.none() : Option.some(row)
      }),
    put: (candidate) =>
      Effect.sync(() => {
        calls.push("put")
        if (options.putOutcome !== undefined) return options.putOutcome
        if (rows.has(candidate.keyDigest)) return { _tag: "ExistingSame" } as const
        rows.set(candidate.keyDigest, candidate)
        return { _tag: "Inserted" } as const
      }),
    evict: (keyDigest) =>
      Effect.sync(() => {
        calls.push("evict")
        return rows.delete(keyDigest)
      })
  }
  return { rows, calls, store }
}

describe("lookups", () => {
  it("answers from the local tier without touching the remote one", async () => {
    const local = tier()
    const remote = tier()
    await Effect.runPromise(local.store.put(entry))
    const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
    expect(Option.getOrUndefined(await Effect.runPromise(combined.get(entry.keyDigest)))).toEqual(entry)
    expect(remote.calls).toEqual([])
  })

  it("falls through to the remote tier and writes the row back locally", async () => {
    const local = tier()
    const remote = tier()
    await Effect.runPromise(remote.store.put(entry))
    const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
    expect(Option.getOrUndefined(await Effect.runPromise(combined.get(entry.keyDigest)))).toEqual(entry)
    // The write-back means the next lookup — on this run or a sibling one — is
    // a local hit.
    expect(local.rows.get(entry.keyDigest)).toEqual(entry)
    const before = remote.calls.length
    await Effect.runPromise(combined.get(entry.keyDigest))
    expect(remote.calls).toHaveLength(before)
  })

  it("reports a miss neither tier can satisfy", async () => {
    const combined = CombinedCacheStore.make({ local: tier().store, remote: tier().store })
    expect(Option.isNone(await Effect.runPromise(combined.get(entry.keyDigest)))).toBe(true)
  })
})

describe("publications", () => {
  it("records locally and publishes to the shared tier", async () => {
    const local = tier()
    const remote = tier()
    const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
    expect(await Effect.runPromise(combined.put(entry))).toEqual({ _tag: "Inserted" })
    expect(remote.rows.get(entry.keyDigest)).toEqual(entry)
  })

  it("does not publish a result the local tier says conflicts", async () => {
    // A local `Conflict` is what drives the strict `Inconsistency` verdict;
    // pushing the losing result to the shared tier would spread it.
    const local = tier({ putOutcome: { _tag: "Conflict" } })
    const remote = tier()
    const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
    expect(await Effect.runPromise(combined.put(entry))).toEqual({ _tag: "Conflict" })
    expect(remote.calls).toEqual([])
  })
})

describe("evictions", () => {
  it("stays local", async () => {
    // Every engine eviction is a "this host observed this row to be poison"
    // judgement, and none of those observations generalize to a tier where
    // another machine may still hold the artifacts this one lost.
    const local = tier()
    const remote = tier()
    await Effect.runPromise(local.store.put(entry))
    await Effect.runPromise(remote.store.put(entry))
    const combined = CombinedCacheStore.make({ local: local.store, remote: remote.store })
    expect(await Effect.runPromise(combined.evict(entry.keyDigest))).toBe(true)
    expect(remote.rows.has(entry.keyDigest)).toBe(true)
  })
})

describe("layer", () => {
  it("builds both tiers from effects and provides one tag", async () => {
    const remote = tier()
    const found = await Effect.runPromise(
      Effect.flatMap(CacheStore.CacheStore, (store) => Effect.andThen(store.put(entry), store.get(entry.keyDigest)))
        .pipe(
          Effect.provide(
            CombinedCacheStore.layer({
              local: Effect.sync(() => tier().store),
              remote: Effect.succeed(remote.store)
            })
          )
        )
    )
    expect(Option.getOrUndefined(found)).toEqual(entry)
    expect(remote.rows.get(entry.keyDigest)).toEqual(entry)
  })
})
