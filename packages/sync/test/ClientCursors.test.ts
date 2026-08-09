/**
 * Cursor materialization and re-subscription behavior of the sync client.
 *
 * @since 0.1.0
 */
import { JournalEvent } from "@smthrs/journal"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (id: string, sequence: number) =>
  new JournalEvent.Entry({
    runId: runId(id),
    seq: seq(sequence),
    eventId: `${id}-${sequence}`,
    sourceId: sourceId("source"),
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

const stubClient = (read: () => Effect.Effect<SyncProtocol.ReadResponse>) =>
  SyncClient.make({
    client: {
      "Sync.Read": read,
      "Sync.Subscribe": () => Stream.empty
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  })

describe("SyncClient cursors", () => {
  it("canonicalizes duplicate supplied cursors through the Map key invariant", async () => {
    const reads: Array<SyncProtocol.WorkspaceCursor> = []
    const client = SyncClient.make({
      client: {
        "Sync.Read": (request: SyncProtocol.ReadRequest) => {
          reads.push(request.cursors)
          return Effect.succeed({
            entries: [entry("duplicate", 5)],
            cursors: [],
            done: true
          })
        },
        "Sync.Subscribe": () => Stream.empty
      } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
    })

    const values = await Effect.runPromise(
      client.subscribe({
        scope: { _tag: "Run", runId: runId("duplicate") },
        cursors: [
          { runId: runId("duplicate"), afterSeq: seq(3) },
          { runId: runId("duplicate"), afterSeq: seq(4) }
        ]
      }).pipe(Stream.take(1), Stream.runCollect)
    )

    // Both cursor ingestion and acknowledgement use Map keys, so a canonical
    // snapshot has one cursor per run and sorting never compares equal run IDs.
    expect(reads).toEqual([[{ runId: "duplicate", afterSeq: 4 }]])
    expect(Array.from(values).map((value) => value.seq)).toEqual([5])
    expect(await Effect.runPromise(client.cursors)).toEqual([{ runId: "duplicate", afterSeq: 5 }])
  })

  it("returns acknowledged cursors in canonical run order regardless of arrival order", async () => {
    let page = 0
    const client = stubClient(() => {
      page += 1
      return Effect.succeed(
        page === 1
          ? {
            entries: [entry("zeta", 0), entry("alpha", 3), entry("mid", 1)],
            cursors: [],
            done: true
          }
          : { entries: [], cursors: [], done: true }
      )
    })

    await Effect.runPromise(
      Stream.runDrain(
        client.subscribe({ scope: { _tag: "Workspace" }, cursors: [] }).pipe(Stream.take(3))
      )
    )
    const cursors = await Effect.runPromise(client.cursors)

    expect(cursors).toEqual([
      { runId: "alpha", afterSeq: 3 },
      { runId: "mid", afterSeq: 1 },
      { runId: "zeta", afterSeq: 0 }
    ])
  })

  it("carries acknowledged cursors into a later subscription so entries are not re-delivered", async () => {
    const reads: Array<SyncProtocol.WorkspaceCursor> = []
    const client = SyncClient.make({
      client: {
        "Sync.Read": (request: SyncProtocol.ReadRequest) => {
          reads.push(request.cursors)
          return Effect.succeed({
            entries: reads.length === 1 ? [entry("run", 0), entry("run", 1)] : [entry("run", 2)],
            cursors: [],
            done: true
          })
        },
        "Sync.Subscribe": () => Stream.empty
      } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
    })

    const scope = { _tag: "Run", runId: runId("run") } as const
    await Effect.runPromise(
      Stream.runDrain(client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2)))
    )
    const second = await Effect.runPromise(
      Stream.runCollect(client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1)))
    )

    expect(reads[0]).toEqual([])
    expect(reads[1]).toEqual([{ runId: "run", afterSeq: 1 }])
    expect(Array.from(second).map((value) => value.seq)).toEqual([2])
  })
})
