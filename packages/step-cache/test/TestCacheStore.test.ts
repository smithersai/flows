import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Effect, Option } from "effect"
import { CacheStore } from "../src/CacheStore.ts"
import * as TestCacheStore from "../src/test/TestCacheStore.ts"

describe("TestCacheStore", () => {
  it.effect("provides a migrated step cache and the journal it appends to", () =>
    Effect.gen(function*() {
      const observed = yield* (
        Effect.gen(function*() {
          const cache = yield* CacheStore
          const journal = yield* Journal.Journal
          yield* cache.put({
            keyDigest: "bundle-cache",
            result: { value: "ok" },
            meta: {},
            createdAtMs: 2,
            recordedRunId: "bundle-run",
            recordedEventSeq: 0
          })
          const entry = yield* cache.get("bundle-cache")
          // The bundle's journal is the one the fold appended to: the put's
          // recorded event is readable through it.
          const page = yield* journal.entries({
            runId: "bundle-run" as JournalEvent.RunId,
            limit: 10
          })
          return { entry, eventTypes: page.entries.map((event) => event.eventType) }
        }).pipe(Effect.provide(TestCacheStore.layer), Effect.scoped)
      )

      expect(Option.getOrThrow(observed.entry).result).toEqual({ value: "ok" })
      expect(observed.eventTypes).toEqual(["flows.cache.recorded"])
    }))
})
