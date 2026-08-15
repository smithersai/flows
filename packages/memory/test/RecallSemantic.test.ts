import { Cause, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Semantic from "../src/RecallSemantic.ts"

describe("RecallSemantic", () => {
  it("ranks by cosine and recency decay", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () =>
        Effect.succeed([
          {
            id: "near",
            kind: "note",
            bank: "bank",
            namespace: { kind: "flow", id: "bank" },
            key: "near",
            text: "near",
            tags: [],
            status: "accepted",
            updatedAtMs: 1000
          },
          {
            id: "old",
            kind: "note",
            bank: "bank",
            namespace: { kind: "flow", id: "bank" },
            key: "old",
            text: "old",
            tags: [],
            status: "accepted",
            updatedAtMs: 0
          }
        ])
    } as unknown as MemoryStore.Service)
    const vectors: Semantic.Vector[] = [
      {
        bank: "bank",
        key: "near",
        model: "test",
        contentDigest: "a",
        dimensions: 2,
        vector: [1, 0],
        updatedAtMs: 1000
      },
      {
        bank: "bank",
        key: "old",
        model: "test",
        contentDigest: "b",
        dimensions: 2,
        vector: [0.99, 0.01],
        updatedAtMs: 0
      }
    ]
    const embedding = Embedding.make(() => Effect.succeed([[1, 0]]))
    const result = await Effect.runPromise(
      Semantic.recall({ banks: ["bank"], query: "q", budget: "low" }, {
        vectorStore: { list: () => Effect.succeed(vectors), upsert: () => Effect.void },
        model: "test",
        nowMs: () => 1000,
        halfLifeMs: 1000
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )
    expect(result[0]?.key).toBe("near")
  })

  it("logs projection failures without failing the committed write path", async () => {
    const embedding = Embedding.make(() => Effect.succeed([[1]]))
    const projector = Semantic.makeProjector({
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: () => Effect.fail(new (class extends Error {})()) as never
      }
    })
    await expect(Effect.runPromise(
      Semantic.projectAfterCommit(projector, {
        bank: "bank",
        key: "key",
        text: "text",
        updatedAtMs: 0
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )).resolves.toBeUndefined()
  })

  it("serializes same-key projections without replaying prior effects", async () => {
    let writes = 0
    const embedding = Embedding.make(() => Effect.succeed([[1]]))
    const projector = Semantic.makeProjector({
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: () =>
          Effect.sync(() => {
            writes += 1
          })
      }
    })
    const row = {
      bank: "bank",
      key: "key",
      text: "text",
      updatedAtMs: 0
    }

    await Effect.runPromise(
      Effect.all([projector(row), projector(row)], { concurrency: "unbounded" }).pipe(
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )

    expect(writes).toBe(2)
  })

  it("propagates projection interruption", async () => {
    const embedding = Embedding.make(() => Effect.interrupt)
    const projector = Semantic.makeProjector({
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: () => Effect.void
      }
    })
    const exit = await Effect.runPromiseExit(
      projector({ bank: "bank", key: "key", text: "text", updatedAtMs: 0 }).pipe(
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })
})
