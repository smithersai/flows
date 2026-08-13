/**
 * The fencing counters: claim, activation, heartbeat, and transition outcomes
 * land in the registry the caller provided, keyed by operation and outcome.
 */
import type { DurableWriter } from "@smthrs/database-next"
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import { Clock, Effect, Metric } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import type { LivenessEvidence, OwnerId } from "../src/Ownership.ts"
import { type RunRow, type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"
import * as RunStoreMetrics from "../src/RunStoreMetrics.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(RunStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

describe("RunStoreMetrics", () => {
  it("counts claim, activation, heartbeat, and transition outcomes through the provided registry", async () => {
    await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-metrics", "{}")
      const pending = snapshot(yield* store.get("run-metrics"))
      const claimedAtMs = yield* Clock.currentTimeMillis

      expect(yield* store.claim("run-metrics", pending, ownerA, claimedAtMs)).toEqual({ _tag: "Claimed", claimedAtMs })
      expect(yield* store.claim("run-metrics", pending, ownerB, claimedAtMs)).toEqual({ _tag: "AlreadyClaimed" })
      expect(yield* store.activate("run-metrics", ownerA, claimedAtMs, pending)).toEqual({ _tag: "Activated" })
      expect(yield* store.heartbeat("run-metrics", ownerA, claimedAtMs + 1)).toEqual({ _tag: "Updated" })
      expect(yield* store.heartbeat("run-metrics", ownerB, claimedAtMs + 2)).toEqual({ _tag: "FenceLost" })
      expect(yield* store.transitionOwned("run-metrics", ownerA, "completed")).toEqual({ _tag: "Transitioned" })
      // The terminal transition released ownership, so a repeat is fenced out.
      expect(yield* store.transitionOwned("run-metrics", ownerA, "completed")).toEqual({ _tag: "FenceLost" })

      expect(yield* count(RunStoreMetrics.claim.Claimed)).toBe(1)
      expect(yield* count(RunStoreMetrics.claim.AlreadyClaimed)).toBe(1)
      expect(yield* count(RunStoreMetrics.activate.Activated)).toBe(1)
      expect(yield* count(RunStoreMetrics.heartbeat.Updated)).toBe(1)
      expect(yield* count(RunStoreMetrics.heartbeat.FenceLost)).toBe(1)
      expect(
        yield* count(Metric.withAttributes(RunStoreMetrics.transition.Transitioned, { to: "completed" }))
      ).toBe(1)
      expect(
        yield* count(Metric.withAttributes(RunStoreMetrics.transition.FenceLost, { to: "completed" }))
      ).toBe(1)
    }))
  })

  it("counts claimAndOwn activations and refused steals through the provided registry", async () => {
    await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-metrics-own", "{}")
      const pending = snapshot(yield* store.get("run-metrics-own"))
      const nowMs = yield* Clock.currentTimeMillis

      expect(yield* store.claimAndOwn("run-metrics-own", pending, ownerA, nowMs)).toEqual({ _tag: "Activated" })
      // Evidence naming a different owner than the snapshot's is refused
      // before any compare-and-swap runs, and still counts as an outcome.
      const mismatched: LivenessEvidence = {
        expectedOwner: ownerB,
        checkedAtMs: nowMs,
        kind: "same-host-pid-dead"
      }
      expect(yield* store.steal("run-metrics-own", pending, ownerB, nowMs, mismatched)).toEqual({
        _tag: "SnapshotChanged"
      })

      expect(yield* count(RunStoreMetrics.claimAndOwn.Activated)).toBe(1)
      expect(yield* count(RunStoreMetrics.steal.SnapshotChanged)).toBe(1)
    }))
  })
})
