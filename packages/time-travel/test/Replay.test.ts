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

  it("pages through the journal and stops once the last page is consumed", async () => {
    const entries = [entry(0, "a"), entry(1, "b"), entry(2, "c"), entry(3, "d")]
    const pageSizes: Array<number | undefined> = []
    const journal = Journal.makeNoop({
      entries: ({ after, limit }) =>
        Effect.sync(() => {
          pageSizes.push(limit)
          const remaining = entries.filter((item) => item.seq > (after ?? -1))
          const page = remaining.slice(0, limit)
          return { entries: page, hasMore: remaining.length > page.length }
        })
    })

    const state = await Effect.runPromise(
      Replay.rederive(
        { lineageId: "run/root", seq: 3 },
        { initial: [] as Array<string>, reduce: (acc, current) => [...acc, String(current.payload)] },
        { runId: "run", pageSize: 2 }
      ).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(CacheStore.layerNoop())
      )
    )

    expect(state).toEqual(["a", "b", "c", "d"])
    expect(pageSizes).toEqual([2, 2])
  })

  it("defaults the page size when the caller supplies none", async () => {
    const limits: Array<number | undefined> = []
    const journal = Journal.makeNoop({
      entries: ({ limit }) =>
        Effect.sync(() => {
          limits.push(limit)
          return { entries: [entry(0, "only")], hasMore: false }
        })
    })

    await Effect.runPromise(
      Replay.rederive(
        { lineageId: "run/root", seq: 0 },
        { initial: 0, reduce: (count: number) => count + 1 },
        { runId: "run" }
      ).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(CacheStore.layerNoop())
      )
    )

    expect(limits).toEqual([100])
  })

  it("skips entries from a sibling lineage and rejects a frame that is absent", async () => {
    const sibling: Entry = { ...entry(0, "sibling"), meta: { lineageId: "run/other" } }
    const journal = Journal.makeNoop({
      entries: () => Effect.succeed({ entries: [sibling], hasMore: false })
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        Replay.rederive(
          { lineageId: "run/root", seq: 5 },
          { initial: [] as Array<string>, reduce: (acc, current) => [...acc, String(current.payload)] },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )
    )

    expect(failure).toMatchObject({
      code: "not_found",
      message: "lineage run/root is not present in run"
    })
  })

  it("fails when the journal cannot be read", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Replay.rederive(
          { lineageId: "run/root", seq: 1 },
          { initial: 0, reduce: (count: number) => count + 1 },
          { runId: "run" }
        ).pipe(
          Effect.provide(Journal.layerNoop()),
          Effect.provide(CacheStore.layerNoop())
        )
      )
    )

    expect(failure).toMatchObject({ code: "unknown", message: "could not read journal" })
  })

  it("fails when a sealed result cannot be read rather than replaying without it", async () => {
    const journal = Journal.makeNoop({
      entries: () => Effect.succeed({ entries: [entry(0, "first", "sealed-key")], hasMore: false })
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        Replay.rederive(
          { lineageId: "run/root", seq: 1 },
          { initial: 0, reduce: (count: number) => count + 1 },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )
    )

    expect(failure).toMatchObject({ code: "unknown", message: "could not read sealed result" })
  })

  it("passes an absent sealed cache entry to the projection as undefined", async () => {
    const journal = Journal.makeNoop({
      entries: () => Effect.succeed({ entries: [entry(0, "first", "missing")], hasMore: false })
    })

    const values = await Effect.runPromise(
      Replay.rederive(
        { lineageId: "run/root", seq: 0 },
        {
          initial: [] as Array<unknown>,
          reduce: (state, _entry, sealed) => [...state, sealed]
        },
        { runId: "run" }
      ).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) }))
      )
    )

    expect(values).toEqual([undefined])
  })

  it("handles malformed additive metadata without treating it as lineage or cache evidence", async () => {
    const malformed = [
      { ...entry(0, "null"), meta: null },
      { ...entry(1, "number"), meta: 1 },
      { ...entry(2, "bad-lineage"), meta: { lineageId: 1 } },
      { ...entry(3, "bad-cache"), meta: { lineageId: "run/root", cacheKey: 1 } }
    ] as ReadonlyArray<Entry>
    const journal = Journal.makeNoop({
      entries: () => Effect.succeed({ entries: malformed, hasMore: false })
    })

    const values = await Effect.runPromise(
      Replay.rederive(
        { lineageId: "run/root", seq: 3 },
        {
          initial: [] as Array<string>,
          reduce: (state, current, sealed) => [...state, `${String(current.payload)}:${String(sealed)}`]
        },
        { runId: "run" }
      ).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(CacheStore.layerNoop())
      )
    )

    expect(values).toEqual([
      "null:undefined",
      "number:undefined",
      "bad-lineage:undefined",
      "bad-cache:undefined"
    ])
  })

  it("terminates a malformed empty continuation page instead of spinning", async () => {
    let pages = 0
    const journal = Journal.makeNoop({
      entries: () =>
        Effect.sync(() => {
          pages += 1
          return { entries: [], hasMore: true }
        })
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        Replay.rederive(
          { lineageId: "run/root", seq: 0 },
          { initial: 0, reduce: (count: number) => count + 1 },
          { runId: "run" }
        ).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(CacheStore.layerNoop())
        )
      )
    )

    expect(pages).toBe(1)
    expect(failure).toMatchObject({ code: "not_found" })
  })
})
