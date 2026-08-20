import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Journal } from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as Fold from "@smthrs/run-store/Fold"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import type { RunRow, RunSnapshot } from "@smthrs/run-store/RunStore"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as TestStores from "../src/test/TestStores.ts"

const owner: OwnerId = { hostId: "waiting-host", pid: 17, nonce: "waiting-owner" }

interface WaitingMaterialization {
  readonly runId: string
  readonly status: string
  readonly waitingReason: string | null
  readonly waitingWakeAtMs: number | null
  readonly waitingToken: string | null
}

const stack = Layer.mergeAll(
  RunStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(SqlJournal.layer({ capacity: 64, overflow: "reject" })),
  Layer.provideMerge(TestStores.database)
)

const withStack = <A, E>(
  body: Effect.Effect<
    A,
    E,
    DurableWriter | Journal | RunStore.RunStore | DurableEngineState.DurableEngineState | SqlClient.SqlClient
  >
) => body.pipe(Effect.provide(stack), Effect.provide(TestClock.layer()), Effect.scoped)

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const waitingRows = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<WaitingMaterialization>`
    SELECT
      run_id AS "runId",
      status,
      waiting_reason AS "waitingReason",
      waiting_wake_at_ms AS "waitingWakeAtMs",
      waiting_token AS "waitingToken"
    FROM flows_runs
    WHERE run_id IN ('waiting-parked', 'waiting-woken')
    ORDER BY run_id
  `
})

const entriesFor = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    const pages = yield* Effect.forEach(runIds, (runId) =>
      journal.entries({ runId: runId as JournalEvent.RunId, limit: 50 }))
    return pages.flatMap((page) =>
      page.entries
    ).filter((entry) =>
      entry.eventType.startsWith("flows.run.") ||
      entry.eventType.startsWith("flows.consensus.")
    )
  })

const foldWaiting = (state: Fold.State) =>
  Array.from(state.runs.values())
    .filter((row) => row.runId === "waiting-parked" || row.runId === "waiting-woken")
    .sort((left, right) => left.runId.localeCompare(right.runId))
    .map((row) => ({
      runId: row.runId,
      status: row.status,
      waitingReason: row.waitingReason,
      waitingWakeAtMs: row.waitingWakeAtMs,
      waitingToken: row.waitingToken
    }))

describe("run state fold waiting materialization", () => {
  it.effect("rebuilds parked and woken waiting columns from journal transition events", () =>
    withStack(Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState

      yield* runs.create("waiting-parked", "{}")
      expect(yield* runs.claimAndOwn("waiting-parked", snapshot(yield* runs.get("waiting-parked")), owner, 1))
        .toEqual({ _tag: "Activated" })
      expect(yield* state.park("waiting-parked", { reason: "timer", wakeAt: 100, token: "wake-token" }, owner))
        .toMatchObject({
          _tag: "Parked",
          row: { reason: "timer", wakeAt: 100, token: "wake-token" }
        })

      yield* runs.create("waiting-woken", "{}")
      expect(yield* runs.claimAndOwn("waiting-woken", snapshot(yield* runs.get("waiting-woken")), owner, 2)).toEqual({
        _tag: "Activated"
      })
      expect(yield* state.park("waiting-woken", { reason: "event", token: "event-token" }, owner)).toMatchObject({
        _tag: "Parked",
        row: { reason: "event", wakeAt: null, token: "event-token" }
      })
      expect(yield* state.wake("waiting-woken")).toMatchObject({
        _tag: "Woken",
        row: { reason: "event", wakeAt: null, token: "event-token" }
      })

      const entries = yield* entriesFor(["waiting-parked", "waiting-woken"])
      const waitingEvents = entries.filter((entry) =>
        entry.eventType === "flows.run.transitioned" &&
        Object.hasOwn(entry.payload as Record<string, unknown>, "waiting")
      )
      expect(waitingEvents.map((entry) => (entry.payload as { readonly waiting: unknown }).waiting)).toEqual([
        { reason: "timer", wakeAt: 100, token: "wake-token" },
        { reason: "event", wakeAt: null, token: "event-token" },
        null
      ])

      const folded = yield* Fold.foldEntries(entries)
      const live = yield* waitingRows
      expect(live).toEqual(foldWaiting(folded))

      yield* Fold.rebuild
      expect(yield* waitingRows).toEqual(live)
    })))
})
