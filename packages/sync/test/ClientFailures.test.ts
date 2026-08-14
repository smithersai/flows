/**
 * Failure, gap, and reconnect behavior of the browser-safe sync client.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal-next"
import { Effect, Exit, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
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
  it.effect("fails with a gap error when a frame starts beyond the covered cursor", () =>
    Effect.gen(function*() {
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

      const exit = yield* Effect.exit(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncGapError)
        expect(failure).toMatchObject({ runId: id, expectedFrom: 0, receivedFrom: 5 })
      }
    }))

  it.effect("accepts holes inside a covered interval without reporting a gap", () =>
    Effect.gen(function*() {
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

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([7])
    }))

  it.effect("drops frames the client has already materialized", () =>
    Effect.gen(function*() {
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

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
      )
      const cursors = yield* (client.cursors)

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
      expect(cursors).toEqual([{ runId: id, afterSeq: 1 }])
    }))

  it.effect("emits only the entries after the supplied cursor", () =>
    Effect.gen(function*() {
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

      const entries = yield* (
        client.subscribe({ scope, cursors: [{ runId: id, afterSeq: seq(2) }] }).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([3])
    }))

  it.effect("fails with a closed error when the server terminates the subscription", () =>
    Effect.gen(function*() {
      const client = stubClient({
        subscribe: () => Stream.succeed<SyncProtocol.Frame>({ _tag: "Closed", reason: "shutdown" })
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncError)
        expect((failure as SyncError).code).toBe("closed")
      }
    }))

  it.effect("ignores heartbeat frames", () =>
    Effect.gen(function*() {
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

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0])
      expect(calls).toBeGreaterThan(1)
    }))

  it.effect("reconnects after a transport failure and resumes from the acknowledged cursor", () =>
    Effect.gen(function*() {
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

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
      // the retry after the transport failure resumes at the acknowledged cursor
      expect(seen[2]).toEqual([{ runId: id, afterSeq: 0 }])
    }))

  // BUG: transport retries recurse immediately with no clock-driven backoff or no-progress budget.
  it.effect.fails("does not spin through repeated live disconnects before retry time advances", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls += 1
          return calls <= 3 ? Stream.fail(new Error("socket reset")) : Stream.never
        }
      })

      const attemptsBeforeTimeAdvanced = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const fiber = yield* Stream.runDrain(client.subscribe({ scope, cursors: [] })).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            for (let turn = 0; turn < 8; turn += 1) yield* Effect.yieldNow
            const attempts = calls
            yield* Fiber.interrupt(fiber)
            return attempts
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )

      expect(attemptsBeforeTimeAdvanced).toBe(1)
    }))

  it.effect("stops live work when the consumer cancels the subscription", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls += 1
          return Stream.never
        }
      })

      const result = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const fiber = yield* Stream.runDrain(client.subscribe({ scope, cursors: [] })).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            yield* Effect.yieldNow
            yield* Fiber.interrupt(fiber)
            const atCancellation = calls
            yield* TestClock.adjust("1 day")
            yield* Effect.yieldNow
            return { afterTimeAdvanced: calls, atCancellation }
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result).toEqual({ atCancellation: 1, afterTimeAdvanced: 1 })
    }))

  it.effect("surfaces a bootstrap transport failure as a transport error", () =>
    Effect.gen(function*() {
      const client = stubClient({
        read: () => Effect.fail(new Error("read failed"))
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncError)
        expect(failure).toMatchObject({ code: "transport_failed", message: "read failed" })
      }
    }))

  it.effect("keeps paging while the bootstrap read reports more durable entries", () =>
    Effect.gen(function*() {
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

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
      expect(requested[0]).toEqual([])
      expect(reads).toBe(2)
    }))

  // BUG: done:false with an empty page recursively issues reads without cursor progress or delay.
  it.effect.fails("does not spin on an incomplete bootstrap page that makes no progress", () =>
    Effect.gen(function*() {
      let reads = 0
      const client = stubClient({
        read: () => {
          reads += 1
          return reads <= 3
            ? Effect.succeed({ entries: [], cursors: [], done: false })
            : Effect.never
        }
      })

      const readsBeforeTimeAdvanced = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const fiber = yield* Stream.runDrain(client.subscribe({ scope, cursors: [] })).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            for (let turn = 0; turn < 8; turn += 1) yield* Effect.yieldNow
            const count = reads
            yield* Fiber.interrupt(fiber)
            return count
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )

      expect(readsBeforeTimeAdvanced).toBe(1)
    }))

  it.effect("makeNoop fails every subscription and reports no cursors", () =>
    Effect.gen(function*() {
      const noop = SyncClient.makeNoop()
      const exit = yield* Effect.exit(
        noop.subscribe({ scope, cursors: [] }).pipe(Stream.runCollect)
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect((failure as SyncError).code).toBe("closed")
      }
      expect(yield* (noop.cursors)).toEqual([])
    }))
})
