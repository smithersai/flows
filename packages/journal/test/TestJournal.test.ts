import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import { AttemptStore } from "../src/AttemptStore.ts"
import { CacheStore } from "../src/CacheStore.ts"
import { Journal } from "../src/Journal.ts"
import { type RunId, type SourceId } from "../src/JournalEvent.ts"
import { RunStore } from "../src/RunStore.ts"
import * as TestJournal from "../src/test/TestJournal.ts"

describe("TestJournal", () => {
  it("provides defaults when no options are supplied", async () => {
    const receipt = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* Journal).emit({
          runId: "default-run" as RunId,
          sourceId: "default-source" as SourceId,
          eventType: "default",
          payload: {}
        })
      }).pipe(
        Effect.provide(TestJournal.layer()),
        Effect.scoped
      )
    )

    expect(receipt).toMatchObject({ _tag: "Accepted", seq: 0, sourceSeq: 0 })
  })

  it("provides the complete production service bundle over in-memory SQLite", async () => {
    const owner = { hostId: "test-host", pid: 1, nonce: "bundle-owner" }
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal
        const runs = yield* RunStore
        const attempts = yield* AttemptStore
        const cache = yield* CacheStore

        yield* runs.create("bundle-run", "{}")
        const pending = yield* runs.get("bundle-run")
        const snapshot = {
          status: pending.status,
          owner: pending.owner,
          heartbeatAtMs: pending.heartbeatAtMs
        }
        const claim = yield* runs.claim("bundle-run", snapshot, owner, 1)
        if (claim._tag !== "Claimed") {
          return yield* Effect.die(new Error("bundle run claim was lost"))
        }
        yield* runs.activate("bundle-run", owner, claim.claimedAtMs, snapshot)
        yield* attempts.put({
          runId: "bundle-run",
          stepKeyDigest: "bundle-step",
          attempt: 0,
          state: "running",
          startedAtMs: 1,
          meta: { poisonPill: false }
        }, owner)
        yield* attempts.finish({
          runId: "bundle-run",
          stepKeyDigest: "bundle-step",
          attempt: 0,
          state: "completed",
          finishedAtMs: 2,
          outcome: { value: "ok" }
        }, owner)
        yield* journal.emit({
          runId: "bundle-run" as RunId,
          sourceId: "bundle" as SourceId,
          eventType: "step.completed",
          payload: { value: "ok" }
        })
        yield* journal.flush
        yield* cache.put({
          keyDigest: "bundle-cache",
          result: { value: "ok" },
          meta: {},
          createdAtMs: 2,
          recordedRunId: "bundle-run",
          recordedEventSeq: 0
        })

        return {
          attempt: yield* attempts.get({
            runId: "bundle-run",
            stepKeyDigest: "bundle-step",
            attempt: 0
          }),
          cache: yield* cache.get("bundle-cache"),
          entries: yield* journal.entries({
            runId: "bundle-run" as RunId,
            limit: 10
          })
        }
      }).pipe(
        Effect.provide(TestJournal.layer({ capacity: 8 })),
        Effect.scoped
      )
    )

    expect(Option.getOrThrow(result.attempt).meta).toEqual({ poisonPill: false })
    expect(Option.getOrThrow(result.cache).result).toEqual({ value: "ok" })
    expect(result.entries.entries.map((entry) => entry.seq)).toEqual([0])
  })
})
