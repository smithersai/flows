import { Journal, JournalEvent } from "@smthrs/journal-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncServer from "../src/SyncServer.ts"

const branchId = "payload-limits" as BranchProtocol.BranchId
const branchRunId = BranchProtocol.branchRunId(branchId)
const runId = "payload-limit-run" as JournalEvent.RunId
const twoMiB = "x".repeat(2 * 1024 * 1024)

const failureOf = <A>(exit: Exit.Exit<A, unknown>): unknown =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined

const entry = (sequence: number, payload: unknown) =>
  new JournalEvent.Entry({
    runId,
    seq: sequence as JournalEvent.Seq,
    eventId: `payload-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sequence as JournalEvent.SourceSeq,
    emittedAtMs: sequence,
    eventType: "event",
    payload,
    meta: null
  })

describe("sync payload and frame limits", () => {
  // BUG: CommandSubmission.args has no encoded-size limit despite frame_too_large being public.
  it.fails("refuses a multi-megabyte command before appending it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const commands = yield* BranchCommands.makeLive
        const share = yield* BranchShare.BranchShare
        const journal = yield* Journal.Journal
        const capability = yield* share.mint({
          branchId,
          capabilityId: "payload-capability",
          access: "write",
          ttlMs: 60_000
        })
        const exit = yield* Effect.exit(
          commands.submit({
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: "oversized-command" as BranchProtocol.CommandId,
              participantId: "alice" as BranchProtocol.ParticipantId,
              name: BranchProtocol.SayCommand,
              args: twoMiB
            })
          })
        )
        return { exit, page: yield* journal.entries({ runId: branchRunId, limit: 10 }) }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestJournal.layer(),
            BranchShare.layerHmac({ secret: "payload-secret" })
          )
        ),
        Effect.provide(TestClock.layer())
      )
    )

    expect(failureOf(result.exit)).toBeInstanceOf(SyncError)
    expect(failureOf(result.exit)).toMatchObject({ code: "frame_too_large" })
    expect(result.page.entries).toEqual([])
  })

  // BUG: SyncServer.read returns one arbitrarily large journal payload without enforcing a frame ceiling.
  it.fails("refuses a page containing one multi-megabyte journal payload", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* Effect.exit(
          server.read({ scope: { _tag: "Run", runId }, cursors: [], limit: 1 })
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Journal.layerNoop({
              entries: () => Effect.succeed({ entries: [entry(0, twoMiB)], hasMore: false })
            }),
            RunCatalog.layerStatic([runId])
          )
        )
      )
    )

    expect(failureOf(exit)).toBeInstanceOf(SyncError)
    expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
  })

  // BUG: aggregate ReadResponse size is unbounded even when each entry is individually moderate.
  it.fails("refuses an aggregate page whose encoded entries exceed a frame ceiling", async () => {
    const entries = Array.from(
      { length: 4 },
      (_, sequence) => entry(sequence, "x".repeat(384 * 1024))
    )
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* Effect.exit(
          server.read({ scope: { _tag: "Run", runId }, cursors: [], limit: entries.length })
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Journal.layerNoop({ entries: () => Effect.succeed({ entries, hasMore: false }) }),
            RunCatalog.layerStatic([runId])
          )
        )
      )
    )

    expect(failureOf(exit)).toBeInstanceOf(SyncError)
    expect(failureOf(exit)).toMatchObject({ code: "frame_too_large" })
  })
})
