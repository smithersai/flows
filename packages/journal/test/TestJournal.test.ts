import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Journal } from "../src/Journal.ts"
import { type RunId, type SourceId } from "../src/JournalEvent.ts"
import * as TestJournal from "../src/test/TestJournal.ts"

describe("TestJournal", () => {
  it("provides defaults when no options are supplied", async () => {
    const receipt = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* Journal).emitDurable({
          runId: "default-run" as RunId,
          sourceId: "default-source" as SourceId,
          eventType: "default",
          payload: {}
        })
      }).pipe(
        Effect.provide(TestJournal.layer()),
        Effect.scoped
      )
    )

    expect(receipt).toMatchObject({ _tag: "Accepted", seq: 0, sourceSeq: 0 })
  })

  it("honours the supplied admission options", async () => {
    const receipts = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal
        const emit = (index: number) =>
          journal.emitDurable({
            runId: "options-run" as RunId,
            sourceId: `source-${index}` as SourceId,
            eventType: "options",
            payload: {}
          })
        return [yield* emit(0), yield* emit(1)]
      }).pipe(
        Effect.provide(TestJournal.layer({ capacity: 8, overflow: "drop-oldest", batchSize: 1 })),
        Effect.scoped
      )
    )

    expect(receipts.map((receipt) => receipt._tag)).toEqual(["Accepted", "Accepted"])
  })
})
