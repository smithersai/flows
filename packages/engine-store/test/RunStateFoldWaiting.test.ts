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
      // A park or wake changes only the waiting columns, so its entry carries
      // only the waiting payload: no status and no lifecycle timestamp
      // (`docs/specs/Concepts/Run State Fold.md`, round 3).
      for (const entry of waitingEvents) {
        const payload = entry.payload as Record<string, unknown>
        expect(Object.hasOwn(payload, "status")).toBe(false)
        expect(Object.hasOwn(payload, "atMs")).toBe(false)
      }

      const folded = yield* Fold.foldEntries(entries)
      const live = yield* waitingRows
      expect(live).toEqual(foldWaiting(folded))

      yield* Fold.rebuild
      expect(yield* waitingRows).toEqual(live)
    })))

  it.effect("a wake after a terminal cancel cannot move finished_at_ms (cancel while parked)", () =>
    withStack(Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const sql = yield* SqlClient.SqlClient

      yield* runs.create("cancelled-parked", "{}")
      expect(yield* runs.claimAndOwn("cancelled-parked", snapshot(yield* runs.get("cancelled-parked")), owner, 1))
        .toEqual({ _tag: "Activated" })
      expect(yield* state.park("cancelled-parked", { reason: "approval", token: "gate" }, owner)).toMatchObject({
        _tag: "Parked"
      })

      // A cancel races the park: `RunDriver.cancelOwned` transitions the run
      // terminal and then wakes it. Under a real clock the wake's reads run
      // later than the transition's, so the TestClock advances between the
      // two — round 2's wake event re-stamped `finished_at_ms` with exactly
      // this later read (`docs/specs/Concepts/Run State Fold.md`, round 3).
      expect(yield* runs.transitionOwned("cancelled-parked", owner, "cancelled")).toEqual({ _tag: "Transitioned" })
      yield* TestClock.adjust("5 seconds")
      expect(yield* state.wake("cancelled-parked")).toMatchObject({
        _tag: "Woken",
        row: { reason: "approval", wakeAt: null, token: "gate" }
      })

      const live = yield* runs.get("cancelled-parked")
      expect(live.status).toBe("cancelled")
      const entries = yield* entriesFor(["cancelled-parked"])
      const folded = yield* Fold.foldEntries(entries)
      const foldedRow = folded.runs.get("cancelled-parked")
      expect(foldedRow).toMatchObject({
        status: "cancelled",
        finishedAtMs: live.finishedAtMs,
        waitingReason: null,
        waitingWakeAtMs: null,
        waitingToken: null
      })

      yield* Fold.rebuild
      const rebuilt = yield* sql<{ readonly finishedAtMs: number | null; readonly status: string }>`
        SELECT status, finished_at_ms AS "finishedAtMs" FROM flows_runs WHERE run_id = 'cancelled-parked'
      `
      expect(rebuilt[0]).toEqual({ status: "cancelled", finishedAtMs: live.finishedAtMs })
    })))
})
