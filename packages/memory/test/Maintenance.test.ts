import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Maintenance from "../src/Maintenance.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "maintenance" } as const

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

const append = (store: MemoryStore.Service, threadId: string, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) =>
      store.appendMessage({
        threadId,
        id: `${threadId}-message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `text-${index}`,
        at: index
      }),
    { discard: true }
  )

describe("Maintenance", () => {
  it("collects expired facts in one finite TTL pass", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "temporary",
        value: "value",
        ttlMs: 5,
        provenance: {}
      })
      yield* store.putFact({ namespace, key: "permanent", value: "value", provenance: {} })
      yield* TestClock.adjust("5 millis")
      const collected = yield* Maintenance.ttlGc
      const facts = yield* store.listFacts({ namespace })
      return { collected, facts }
    }))

    expect(result.collected).toEqual({ deletedFacts: 1 })
    expect(result.facts.map((fact) => fact.key)).toEqual(["permanent"])
  })

  it("deletes oldest history until the approximate token budget is met", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "one", role: "user", text: "1111", at: 1 })
      yield* store.appendMessage({ threadId: "thread", id: "two", role: "assistant", text: "2222", at: 2 })
      yield* store.appendMessage({ threadId: "thread", id: "three", role: "user", text: "3333", at: 3 })
      const limited = yield* Maintenance.limitHistory({ maxTokens: 8, charsPerToken: 1 })
      const messages = yield* store.listMessages({ threadId: "thread" })
      return { limited, messages }
    }))

    expect(result.limited).toEqual({ deletedMessages: 1 })
    expect(result.messages.map((message) => message.id)).toEqual(["two", "three"])
  })

  it("writes the summary before deleting old messages in one transaction", async () => {
    const summarized: Array<ReadonlyArray<string>> = []
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 5)
      const compacted = yield* Maintenance.compact({
        summarizer: {
          summarize: ({ messages }) =>
            Effect.sync(() => {
              summarized.push(messages.map((message) => message.id))
              return "summary text"
            })
        },
        makeSummaryId: () => "summary-fixed"
      })
      const messages = yield* store.listMessages({ threadId: "thread" })
      return { compacted, messages }
    }))

    expect(summarized).toEqual([["thread-message-0", "thread-message-1", "thread-message-2"]])
    expect(result.compacted).toEqual({ compactedThreads: 1, deletedMessages: 3 })
    expect(result.messages).toEqual([
      { threadId: "thread", id: "summary-fixed", role: "system", text: "summary text", at: 0 },
      { threadId: "thread", id: "thread-message-3", role: "assistant", text: "text-3", at: 3 },
      { threadId: "thread", id: "thread-message-4", role: "user", text: "text-4", at: 4 }
    ])
  })

  it("keeps source messages when the summarizer or summary write fails", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "summarizer-failure", 4)
      const summarizerExit = yield* Effect.exit(
        Maintenance.compact({
          threadId: "summarizer-failure",
          summarizer: { summarize: () => Effect.fail("summary unavailable") }
        })
      )
      const afterSummarizerFailure = yield* store.listMessages({ threadId: "summarizer-failure" })

      yield* append(store, "write-failure", 4)
      yield* store.appendMessage({
        threadId: "other",
        id: "summary-conflict",
        role: "system",
        text: "existing",
        at: 0
      })
      const writeExit = yield* Effect.exit(
        Maintenance.compact({
          threadId: "write-failure",
          summarizer: { summarize: () => Effect.succeed("summary") },
          makeSummaryId: () => "summary-conflict"
        })
      )
      const afterWriteFailure = yield* store.listMessages({ threadId: "write-failure" })
      return { summarizerExit, afterSummarizerFailure, writeExit, afterWriteFailure }
    }))

    expect(Exit.isFailure(result.summarizerExit)).toBe(true)
    expect(result.afterSummarizerFailure.map((message) => message.id)).toEqual([
      "summarizer-failure-message-0",
      "summarizer-failure-message-1",
      "summarizer-failure-message-2",
      "summarizer-failure-message-3"
    ])
    expect(Exit.isFailure(result.writeExit)).toBe(true)
    expect(result.afterWriteFailure.map((message) => message.id)).toEqual([
      "write-failure-message-0",
      "write-failure-message-1",
      "write-failure-message-2",
      "write-failure-message-3"
    ])
  })

  it("cancels compaction through fiber interruption without deleting history", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 4)
      const started = yield* Deferred.make<void>()
      const fiber = yield* Maintenance.compact({
        threadId: "thread",
        summarizer: {
          summarize: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        }
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* store.listMessages({ threadId: "thread" })
    }))

    expect(messages.map((message) => message.id)).toEqual([
      "thread-message-0",
      "thread-message-1",
      "thread-message-2",
      "thread-message-3"
    ])
  })
})
