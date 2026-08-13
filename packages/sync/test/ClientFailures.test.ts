/**
 * Failure, gap, and reconnect behavior of the browser-safe sync client.
 *
 * @since 0.1.0
 */
import { JournalEvent } from "@smthrs/journal-next"
import { Effect, Exit, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError, SyncGapError } from "../src/SyncError.ts"
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

interface Stub {
  readonly read?: (
    request: SyncProtocol.ReadRequest
  ) => Effect.Effect<SyncProtocol.ReadResponse, unknown>
  readonly subscribe?: (
    request: SyncProtocol.SubscribeRequest
  ) => Stream.Stream<SyncProtocol.Frame, unknown>
}

const stubClient = (stub: Stub) =>
  SyncClient.make({
    client: {
      "Sync.Read": stub.read ??
        (() => Effect.succeed({ entries: [], cursors: [], done: true })),
      "Sync.Subscribe": stub.subscribe ?? (() => Stream.empty)
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  })

const id = runId("failures")
const scope = { _tag: "Run", runId: id } as const

describe("SyncClient failure paths", () => {
  it("fails with a gap error when a frame starts beyond the covered cursor", async () => {
    const client = stubClient({
      subscribe: () =>
        Stream.succeed<SyncProtocol.Frame>({
          _tag: "Entries",
          runId: id,
          fromSeq: seq(5),
          toSeq: seq(5),
          entries: [entry("failures", 5)]
        })
    })

    const exit = await Effect.runPromiseExit(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect(failure).toBeInstanceOf(SyncGapError)
      expect(failure).toMatchObject({ runId: id, expectedFrom: 0, receivedFrom: 5 })
    }
  })

  it("accepts holes inside a covered interval without reporting a gap", async () => {
    const client = stubClient({
      subscribe: () =>
        Stream.succeed<SyncProtocol.Frame>({
          _tag: "Entries",
          runId: id,
          // the server covered 0..7 but only entry 7 survived admission
          fromSeq: seq(0),
          toSeq: seq(7),
          entries: [entry("failures", 7)]
        })
    })

    const entries = await Effect.runPromise(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
    )

    expect(Array.from(entries).map((value) => value.seq)).toEqual([7])
  })

  it("drops frames the client has already materialized", async () => {
    let calls = 0
    const client = stubClient({
      subscribe: () => {
        calls++
        return calls === 1
          ? Stream.succeed<SyncProtocol.Frame>({
            _tag: "Entries",
            runId: id,
            fromSeq: seq(0),
            toSeq: seq(1),
            entries: [entry("failures", 0), entry("failures", 1)]
          })
          : Stream.succeed<SyncProtocol.Frame>({
            // a redelivery of an already-consumed interval
            _tag: "Entries",
            runId: id,
            fromSeq: seq(0),
            toSeq: seq(1),
            entries: [entry("failures", 0), entry("failures", 1)]
          })
      }
    })

    const entries = await Effect.runPromise(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
    )
    const cursors = await Effect.runPromise(client.cursors)

    expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
    expect(cursors).toEqual([{ runId: id, afterSeq: 1 }])
  })

  it("emits only the entries after the supplied cursor", async () => {
    const client = stubClient({
      subscribe: () =>
        Stream.succeed<SyncProtocol.Frame>({
          _tag: "Entries",
          runId: id,
          fromSeq: seq(0),
          toSeq: seq(3),
          entries: [entry("failures", 1), entry("failures", 2), entry("failures", 3)]
        })
    })

    const entries = await Effect.runPromise(
      client.subscribe({ scope, cursors: [{ runId: id, afterSeq: seq(2) }] }).pipe(
        Stream.take(1),
        Stream.runCollect
      )
    )

    expect(Array.from(entries).map((value) => value.seq)).toEqual([3])
  })

  it("fails with a closed error when the server terminates the subscription", async () => {
    const client = stubClient({
      subscribe: () => Stream.succeed<SyncProtocol.Frame>({ _tag: "Closed", reason: "shutdown" })
    })

    const exit = await Effect.runPromiseExit(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect(failure).toBeInstanceOf(SyncError)
      expect((failure as SyncError).code).toBe("closed")
    }
  })

  it("ignores heartbeat frames", async () => {
    let calls = 0
    const client = stubClient({
      subscribe: () => {
        calls++
        return calls === 1
          ? Stream.succeed<SyncProtocol.Frame>({ _tag: "Heartbeat" })
          : Stream.succeed<SyncProtocol.Frame>({
            _tag: "Entries",
            runId: id,
            fromSeq: seq(0),
            toSeq: seq(0),
            entries: [entry("failures", 0)]
          })
      }
    })

    const entries = await Effect.runPromise(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
    )

    expect(Array.from(entries).map((value) => value.seq)).toEqual([0])
    expect(calls).toBeGreaterThan(1)
  })

  it("reconnects after a transport failure and resumes from the acknowledged cursor", async () => {
    let calls = 0
    const seen: Array<SyncProtocol.WorkspaceCursor> = []
    const client = stubClient({
      subscribe: (request) => {
        calls++
        seen.push(request.cursors)
        if (calls === 1) {
          return Stream.succeed<SyncProtocol.Frame>({
            _tag: "Entries",
            runId: id,
            fromSeq: seq(0),
            toSeq: seq(0),
            entries: [entry("failures", 0)]
          })
        }
        if (calls === 2) {
          return Stream.fail(new Error("socket reset"))
        }
        return Stream.succeed<SyncProtocol.Frame>({
          _tag: "Entries",
          runId: id,
          fromSeq: seq(1),
          toSeq: seq(1),
          entries: [entry("failures", 1)]
        })
      }
    })

    const entries = await Effect.runPromise(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
    )

    expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
    // the retry after the transport failure resumes at the acknowledged cursor
    expect(seen[2]).toEqual([{ runId: id, afterSeq: 0 }])
  })

  it("surfaces a bootstrap transport failure as a transport error", async () => {
    const client = stubClient({
      read: () => Effect.fail(new Error("read failed"))
    })

    const exit = await Effect.runPromiseExit(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect(failure).toBeInstanceOf(SyncError)
      expect(failure).toMatchObject({ code: "transport_failed", message: "read failed" })
    }
  })

  it("keeps paging while the bootstrap read reports more durable entries", async () => {
    let reads = 0
    const requested: Array<SyncProtocol.WorkspaceCursor> = []
    const client = stubClient({
      read: (request) => {
        reads++
        requested.push(request.cursors)
        return reads === 1
          ? Effect.succeed({
            entries: [entry("failures", 0)],
            cursors: [{ runId: id, afterSeq: seq(0) }],
            done: false
          })
          : Effect.succeed({
            entries: [entry("failures", 1)],
            cursors: [{ runId: id, afterSeq: seq(1) }],
            done: true
          })
      }
    })

    const entries = await Effect.runPromise(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
    )

    expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
    expect(requested[0]).toEqual([])
    expect(reads).toBe(2)
  })

  it("makeNoop fails every subscription and reports no cursors", async () => {
    const noop = SyncClient.makeNoop()
    const exit = await Effect.runPromiseExit(
      noop.subscribe({ scope, cursors: [] }).pipe(Stream.runCollect)
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect((failure as SyncError).code).toBe("closed")
    }
    expect(await Effect.runPromise(noop.cursors)).toEqual([])
  })
})
