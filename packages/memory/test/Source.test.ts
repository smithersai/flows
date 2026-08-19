import { Cause, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Source from "../src/Source.ts"

describe("Source", () => {
  it("returns no injection after the advisory timeout", async () => {
    const store = MemoryStore.MemoryStore.of({
      listNotes: () => Effect.never
    } as unknown as MemoryStore.Service)
    const recall = Recall.makeNoop()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Source.declaredText(Source.make(), {
          lineageId: "lineage",
          iteration: 1,
          banks: ["bank"],
          query: "q"
        }).pipe(
          Effect.provideService(MemoryStore.MemoryStore, store),
          Effect.provideService(Recall.Recall, recall),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust("5 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result).toMatchObject({ text: "" })
  })

  it("produces the agent's declared memory text shape and freezes a retry snapshot", async () => {
    let reads = 0
    const store = MemoryStore.MemoryStore.of({
      listNotes: () =>
        Effect.sync(() => {
          reads += 1
          return [{ namespace: "bank", text: `primer-${reads}` }]
        })
    } as unknown as MemoryStore.Service)
    const recall = Recall.make({ recall: () => Effect.succeed([]) })
    const source = Source.make()
    const input = { lineageId: "lineage", iteration: 2, banks: ["bank"], query: "q" }
    const first = await Effect.runPromise(
      Source.declaredText(source, input).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, recall)
      )
    )
    const second = await Effect.runPromise(
      Source.declaredText(source, input).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, recall)
      )
    )
    expect(first.text).toContain("primer-1")
    expect(second).toEqual(first)
    expect(reads).toBe(1)
    expect(first).toHaveProperty("digest")
  })

  it("preserves a complete fence when applying the byte cap", async () => {
    const store = MemoryStore.MemoryStore.of({
      listNotes: () => Effect.succeed([{ namespace: "bank", text: "x".repeat(1_000) }])
    } as unknown as MemoryStore.Service)
    const result = await Effect.runPromise(
      Source.declaredText(Source.make(), {
        lineageId: "lineage",
        iteration: 3,
        banks: ["bank"],
        query: "q",
        maxBytes: 64
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, Recall.makeNoop())
      )
    )

    expect(Source.byteLength(result.text)).toBeLessThanOrEqual(64)
    expect(result.text).toMatch(/^<flows_memory_context>/)
    expect(result.text).toMatch(/<\/flows_memory_context>$/)
  })

  it("propagates fiber interruption instead of degrading it", async () => {
    const store = MemoryStore.MemoryStore.of({
      listNotes: () => Effect.interrupt
    } as unknown as MemoryStore.Service)
    const exit = await Effect.runPromiseExit(
      Source.declaredText(Source.make(), {
        lineageId: "interrupted",
        iteration: 1,
        banks: ["bank"],
        query: "q"
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, Recall.makeNoop())
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })
})
