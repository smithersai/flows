import * as CacheStore from "@smithers/journal/CacheStore"
import * as Journal from "@smithers/journal/Journal"
import type { Entry, RunId, Seq, SourceId, SourceSeq } from "@smithers/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Replay from "../src/Replay.ts"

const entry = (seq: number, payload: string, cacheKey?: string): Entry => ({
  runId: "run" as RunId,
  seq: seq as Seq,
  eventId: `event-${seq}`,
  sourceId: "replay-test" as SourceId,
  sourceSeq: seq as SourceSeq,
  emittedAtMs: seq,
  eventType: "step.completed",
  payload,
  meta: {
    lineageId: "run/root",
    ...(cacheKey === undefined ? {} : { cacheKey })
  }
})

describe("Replay", () => {
  it("re-derives an identical projection from sealed evidence without dispatching", async () => {
    const entries = [entry(0, "first"), entry(1, "second", "sealed-key"), entry(2, "after-frame")]
    const before = structuredClone(entries)
    let dispatcherCalls = 0
    const dispatcher = (): void => {
      dispatcherCalls += 1
    }
    const journal = Journal.makeNoop({
      entries: ({ after, limit }) =>
        Effect.succeed({
          entries: entries.filter((item) => item.seq > (after ?? -1)).slice(0, limit),
          hasMore: false
        })
    })
    const cache = CacheStore.makeNoop({
      get: (key) =>
        Effect.succeed(
          key === "sealed-key"
            ? Option.some({
              keyDigest: key,
              result: "sealed-result",
              meta: {},
              createdAtMs: 1,
              recordedRunId: "run",
              recordedEventSeq: 1
            })
            : Option.none()
        )
    })
    const replay = Replay.rederive(
      { lineageId: "run/root", seq: 1 },
      {
        initial: [] as Array<string>,
        reduce: (state, current, sealed) => [...state, `${String(current.payload)}:${String(sealed)}`]
      },
      { runId: "run", pageSize: 10 }
    ).pipe(
      Effect.provide(Layer.succeed(Journal.Journal, journal)),
      Effect.provide(Layer.succeed(CacheStore.CacheStore, cache))
    )

    const first = await Effect.runPromise(replay)
    const second = await Effect.runPromise(replay)

    expect(first).toEqual(["first:undefined", "second:sealed-result"])
    expect(second).toEqual(first)
    expect(dispatcherCalls).toBe(0)
    expect(entries).toEqual(before)
    expect(dispatcher).toBeTypeOf("function")
  })
})
