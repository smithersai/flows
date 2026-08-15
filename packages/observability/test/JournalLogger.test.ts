import { Journal, JournalEvent } from "@smthrs/journal-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { layerJournalForwarding } from "../src/JournalLogger.ts"

const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(program.pipe(Effect.scoped))

describe("JournalLogger", () => {
  it("forwards versioned records without changing the logged effect", async () => {
    const result = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("hello")
        yield* Effect.sleep("10 millis")
        yield* journal.flush
        return yield* journal.entries({ runId: "obs-run" as JournalEvent.RunId, limit: 10 })
      }).pipe(
        // One journal layer value, provided once: each `TestJournal.layer()`
        // call opens its own `:memory:` database, so building two of them would
        // forward into a different database than the assertion reads.
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: "obs-run" }), TestJournal.layer()))
      )
    )

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.eventType).toBe("telemetry.log")
    expect(result.entries[0]?.payload).toMatchObject({ version: 1, level: "Info", message: ["hello"] })
  })

  it("drops when full and swallows journal failures", async () => {
    const result = await run(
      Effect.logInfo("does not fail").pipe(
        Effect.as("ok"),
        Effect.provide(
          Layer.provide(layerJournalForwarding({ runId: "drop-run", capacity: 1 }), Journal.layerNoop())
        )
      )
    )
    expect(result).toBe("ok")
  })
})
