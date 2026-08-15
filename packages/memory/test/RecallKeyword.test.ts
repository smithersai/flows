import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Keyword from "../src/RecallKeyword.ts"

const rows = [
  { key: "alpha", text: "alpha beta", tags: ["scope:x"], status: "accepted", updatedAtMs: 1 },
  { key: "new", text: "alpha", tags: ["scope:y"], status: "accepted", updatedAtMs: 2 },
  { key: "hidden", text: "alpha alpha", tags: ["scope:x"], status: "rejected", updatedAtMs: 3 }
]

describe("RecallKeyword", () => {
  it("scores terms, applies authoritative tags/status, and breaks ties by recency", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () => Effect.succeed(rows)
    } as unknown as MemoryStore.Service)
    const result = await Effect.runPromise(
      Keyword.recall({
        banks: ["bank"],
        query: "alpha",
        tagGroups: [{ tags: ["scope:x"], match: "all_strict" }],
        maxTokens: 2048
      }).pipe(Effect.provideService(MemoryStore.MemoryStore, store))
    )
    expect(result.map(({ key }) => key)).toEqual(["alpha"])
  })

  it("preserves Smithers substring matching instead of exact-token matching", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () => Effect.succeed(rows)
    } as unknown as MemoryStore.Service)
    const result = await Effect.runPromise(
      Keyword.recall({ banks: ["bank"], query: "lph" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )
    expect(result.map(({ key }) => key)).toEqual(["new", "alpha"])
  })
})
