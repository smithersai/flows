/**
 * Boundary delivery behavior of the sync client.
 *
 * @since 0.1.0
 */
import { JournalEvent } from "@smithers/journal"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (sequence: number) =>
  new JournalEvent.Entry({
    runId: runId("boundary"),
    seq: seq(sequence),
    eventId: `boundary-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

describe("SyncClient covered-frame boundaries", () => {
  it("filters an entry exactly at the cursor while admitting the later entry in the same frame", async () => {
    const client = SyncClient.make({
      client: {
        "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
        "Sync.Subscribe": () =>
          Stream.succeed<SyncProtocol.Frame>({
            _tag: "Entries",
            runId: runId("boundary"),
            fromSeq: seq(2),
            toSeq: seq(3),
            entries: [entry(2), entry(3)]
          })
      } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
    })

    const entries = await Effect.runPromise(
      client.subscribe({
        scope: { _tag: "Run", runId: runId("boundary") },
        cursors: [{ runId: runId("boundary"), afterSeq: seq(2) }]
      }).pipe(Stream.take(1), Stream.runCollect)
    )

    expect(Array.from(entries).map((value) => value.seq)).toEqual([3])
    expect(await Effect.runPromise(client.cursors)).toEqual([{ runId: "boundary", afterSeq: 3 }])
  })
})
