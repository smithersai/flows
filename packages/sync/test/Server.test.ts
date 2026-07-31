import { Journal, JournalEvent } from "@smithers/journal"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = "gapped-run" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceId = "source" as JournalEvent.SourceId
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (value: number) =>
  new JournalEvent.Entry({
    runId,
    seq: seq(value),
    eventId: `event-${value}`,
    sourceId,
    sourceSeq: sourceSeq(value),
    emittedAtMs: value,
    eventType: "event",
    payload: value,
    meta: null
  })

const makeServer = (entries: ReadonlyArray<JournalEvent.Entry>) =>
  SyncServer.makeLive.pipe(
    Effect.provide(
      Layer.mergeAll(
        Journal.layerNoop({
          stream: ({ afterSequence }) =>
            Stream.fromIterable(entries.filter((entry) => afterSequence === undefined || entry.seq > afterSequence))
        }),
        RunCatalog.layerStatic([runId])
      )
    )
  )

describe("SyncServer", () => {
  it("covers legitimate journal gaps and enforces subscription credit", async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* makeServer([entry(2), entry(5), entry(8)])
        return yield* server.subscribe({
          scope: { _tag: "Run", runId },
          cursors: [{ runId, afterSeq: seq(0) }],
          credit: 2
        }).pipe(Stream.runCollect)
      })
    )

    expect(Array.from(frames)).toMatchObject([
      { _tag: "Entries", fromSeq: 1, toSeq: 2, entries: [{ seq: 2 }] },
      { _tag: "Entries", fromSeq: 3, toSeq: 5, entries: [{ seq: 5 }] }
    ])
  })

  it("emits no frames when credit is zero", async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* makeServer([entry(0)])
        return yield* server.subscribe({
          scope: { _tag: "Run", runId },
          cursors: [],
          credit: 0
        }).pipe(Stream.runCollect)
      })
    )

    expect(Array.from(frames)).toEqual([])
  })
})
