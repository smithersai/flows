import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"

describe("Embedding", () => {
  it("preserves ordered batches and supports single embed", async () => {
    const service = Embedding.make((inputs) => Effect.succeed(inputs.map((_, index) => [index, 1])))
    const result = await Effect.runPromise(service.embedMany(["a", "b"]))
    expect(result.embeddings.map(({ vector }) => vector)).toEqual([[0, 1], [1, 1]])
    await expect(Effect.runPromise(service.embed("a"))).resolves.toEqual({ vector: [0, 1] })
  })

  it("provides deterministic fake vectors and rejects malformed batches", async () => {
    const service = Embedding.make((inputs) => Effect.succeed(inputs.length === 1 ? [] : inputs.map(() => [1])))
    await expect(Effect.runPromise(service.embed("bad"))).rejects.toMatchObject({ code: "embedding_unavailable" })
    const fake = await Effect.runPromise(Embedding.makeNoop().embedMany([]))
    expect(fake.embeddings).toEqual([])
  })
})
