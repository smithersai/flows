import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CacheStore from "../src/CacheStore.ts"

describe("service contracts", () => {
  it("constructs and exercises the CacheStore stub", async () => {
    const service = CacheStore.makeNoop()
    const entry: CacheStore.CacheEntry = {
      keyDigest: "digest",
      result: {},
      meta: {},
      createdAtMs: 0,
      recordedRunId: "run",
      recordedEventSeq: 0
    }
    expect((await Effect.runPromise(Effect.flip(service.get("digest")))).message).toContain("get")
    expect((await Effect.runPromise(Effect.flip(service.put(entry)))).message).toContain("put")
    expect((await Effect.runPromise(Effect.flip(service.evict("digest")))).message).toContain("evict")

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* CacheStore.CacheStore).get("digest")
      }).pipe(
        Effect.provide(CacheStore.layerNoop({
          get: () => Effect.succeed(Option.none())
        }))
      )
    )
    expect(Option.isNone(result)).toBe(true)
  })
})
