/**
 * The ownership contract over the injected consensus strategy.
 *
 * One shared body — Bazel `GraphTester` style — runs the claim, activation,
 * steal, recovery, and release lifecycle against BOTH strategies: the
 * in-memory `Consensus.layerLocal` and the database-backed
 * `SqlConsensus.layer`. Each instantiation also pins rule R6: ownership
 * transitions append `flows.consensus.*` events through the journal in
 * context, and heartbeats never do.
 *
 * A second section pins the delegation seam itself: the strategy is
 * authoritative, so when its lease disagrees with the run-row materialization
 * — driven here by operating the strategy directly — the store reports the
 * loss and reconverges the row.
 *
 * Governing design: `docs/specs/Concepts/Journal Consensus.md`.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Consensus from "@smthrs/journal/Consensus"
import { Journal } from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Clock, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { heartbeatStaleAfter } from "../src/Heartbeat.ts"
import * as Migrations from "../src/Migrations.ts"
import type { LivenessEvidence, OwnerId } from "../src/Ownership.ts"
import { type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrationsLayer = Layer.effectDiscard(DatabaseMigrations.run([JournalMigrations.set, Migrations.set]))

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 202, nonce: "owner-b" }
const observer: OwnerId = { hostId: "host-a", pid: 303, nonce: "observer" }

const pending: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }

const evidence = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: expectedOwner.hostId === claimant.hostId ? "same-host-pid-dead" : "cross-host-unreachable-stale"
})

const journalLayer = SqlJournal.layer({ capacity: 64, overflow: "reject" })

const stackFor = (
  strategy: Layer.Layer<Consensus.Consensus, never, DurableWriter.DurableWriter | SqlClient.SqlClient>
) =>
  RunStoreLive.layer.pipe(
    Layer.provideMerge(strategy),
    Layer.provideMerge(journalLayer),
    Layer.provideMerge(Layer.provideMerge(migrationsLayer, TestDatabase.layer))
  )

const consensusEvents = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType.startsWith("flows.consensus."))
      .map((entry) => entry.eventType.replace("flows.consensus.", ""))
  })

const suite = (
  name: string,
  strategy: Layer.Layer<Consensus.Consensus, never, DurableWriter.DurableWriter | SqlClient.SqlClient>
) => {
  const withStack = <A, E>(
    body: Effect.Effect<
      A,
      E,
      Consensus.Consensus | Journal | RunStore | DurableWriter.DurableWriter | SqlClient.SqlClient
    >
  ) =>
    Effect.scoped(
      body.pipe(Effect.provide(stackFor(strategy)), Effect.provide(TestClock.layer()))
    )

  describe(`ownership over ${name}`, () => {
    it.effect("appends claimed and activated events for the two-phase lifecycle, and none for heartbeats", () =>
      withStack(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-lifecycle", "{}")
        const nowMs = yield* Clock.currentTimeMillis
        expect(yield* store.claim("run-lifecycle", pending, ownerA, nowMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
        expect(yield* store.activate("run-lifecycle", ownerA, nowMs, pending)).toEqual({ _tag: "Activated" })
        expect(yield* store.heartbeat("run-lifecycle", ownerA, nowMs + 5)).toEqual({ _tag: "Updated" })
        expect(yield* consensusEvents("run-lifecycle")).toEqual(["claimed", "activated"])

        expect(yield* store.transitionOwned("run-lifecycle", ownerA, "suspended")).toEqual({
          _tag: "Transitioned"
        })
        expect(yield* consensusEvents("run-lifecycle")).toEqual(["claimed", "activated", "released"])
        // The released lease refuses further pulses.
        expect(yield* store.heartbeat("run-lifecycle", ownerA, nowMs + 6)).toEqual({ _tag: "FenceLost" })
      })))

    it.effect("re-owns one's own stale run through release, re-claim, and activation", () =>
      withStack(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-reown", "{}")
        expect(yield* store.claimAndOwn("run-reown", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        const stale: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: 0 }
        expect(yield* store.claimAndOwn("run-reown", stale, ownerA, nowMs)).toEqual({ _tag: "Activated" })
        const row = yield* store.get("run-reown")
        expect(row.owner).toEqual(ownerA)
        expect(row.heartbeatAtMs).toBe(nowMs)
        expect(yield* consensusEvents("run-reown")).toEqual(["claimed", "activated", "claimed", "activated"])
      })))

    it.effect("records a steal as stolen, and claimAndOwn over a stale rival as stolen plus activated", () =>
      withStack(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-stolen", "{}")
        expect(yield* store.claimAndOwn("run-stolen", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        const stale: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: 0 }
        expect(yield* store.steal("run-stolen", stale, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
        expect(yield* consensusEvents("run-stolen")).toEqual(["claimed", "activated", "stolen"])
        expect(yield* store.activate("run-stolen", ownerB, nowMs, stale)).toEqual({ _tag: "Activated" })
        expect(yield* consensusEvents("run-stolen")).toEqual(["claimed", "activated", "stolen", "activated"])

        yield* store.create("run-taken-whole", "{}")
        expect(yield* store.claimAndOwn("run-taken-whole", pending, ownerA, nowMs)).toEqual({ _tag: "Activated" })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const laterMs = yield* Clock.currentTimeMillis
        const staleAgain: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: nowMs }
        expect(
          yield* store.claimAndOwn("run-taken-whole", staleAgain, ownerB, laterMs, evidence(ownerA, ownerB, laterMs))
        ).toEqual({ _tag: "Activated" })
        expect(yield* consensusEvents("run-taken-whole")).toEqual(["claimed", "activated", "stolen", "activated"])
      })))

    it.effect("records an abandoned claim as released and a recovered claim as expired", () =>
      withStack(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-claims", "{}")
        const first = yield* store.claim("run-claims", pending, ownerA, 0)
        expect(first).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        expect(yield* store.abandonClaim("run-claims", ownerA, 0)).toEqual({ _tag: "Abandoned" })
        expect(yield* consensusEvents("run-claims")).toEqual(["claimed", "released"])

        const again = yield* store.claim("run-claims", pending, ownerA, 0)
        expect(again).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.recoverClaim("run-claims", ownerA, 0, observer, nowMs, evidence(ownerA, observer, nowMs))
        ).toEqual({ _tag: "Recovered" })
        expect(yield* consensusEvents("run-claims")).toEqual(["claimed", "released", "claimed", "expired"])
        const row = yield* store.get("run-claims")
        expect(row.claim).toBeNull()
      })))
  })
}

suite("Consensus.layerLocal", Consensus.layerLocal)
suite("SqlConsensus.layer", SqlConsensus.layer)

describe("the strategy is authoritative when the materialization disagrees", () => {
  const withLocal = <A, E>(
    body: Effect.Effect<
      A,
      E,
      Consensus.Consensus | Journal | RunStore | DurableWriter.DurableWriter | SqlClient.SqlClient
    >
  ) =>
    Effect.scoped(
      body.pipe(Effect.provide(stackFor(Consensus.layerLocal)), Effect.provide(TestClock.layer()))
    )

  it.effect("claim and claimAndOwn report the row-classified loss when the lease refuses the grant", () =>
    withLocal(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-lease-claimed", "{}")
      // The lease is taken behind the store's back, so the row still admits
      // the claim the strategy refuses.
      expect((yield* consensus.claim("run-lease-claimed", ownerB, 0))._tag).toBe("Claimed")
      expect(yield* store.claim("run-lease-claimed", pending, ownerA, 0)).toEqual({ _tag: "SnapshotChanged" })
      expect(yield* store.claimAndOwn("run-lease-claimed", pending, ownerA, 0)).toEqual({
        _tag: "SnapshotChanged"
      })
    })))

  it.effect("claimAndOwn releases its fresh grant when the strategy revokes the activation", () =>
    Effect.gen(function*() {
      const revoked = Layer.effect(
        Consensus.Consensus,
        Effect.map(Consensus.makeLocal, (local) =>
          Consensus.make({
            ...local,
            activate: () => Effect.succeed({ _tag: "Lost" })
          }))
      )
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore
          const consensus = yield* Consensus.Consensus
          yield* store.create("run-revoked", "{}")
          const result = yield* store.claimAndOwn("run-revoked", pending, ownerA, 0)
          // The compensating release freed the lease for the next claimant.
          expect((yield* consensus.claim("run-revoked", ownerB, 1))._tag).toBe("Claimed")
          return result
        }).pipe(Effect.provide(stackFor(revoked)), Effect.provide(TestClock.layer()))
      )
      expect(outcome).toEqual({ _tag: "SnapshotChanged" })
    }))

  it.effect("activate reports ClaimLost and clears the stale claim columns when the lease moved on", () =>
    withLocal(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-lease-lost", "{}")
      expect(yield* store.claim("run-lease-lost", pending, ownerA, 0)).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      yield* consensus.release("run-lease-lost", ownerA)
      expect(yield* store.activate("run-lease-lost", ownerA, 0, pending)).toEqual({ _tag: "ClaimLost" })
      const row = yield* store.get("run-lease-lost")
      expect(row.claim).toBeNull()
    })))

  it.effect("steal reports the row-classified loss when the lease still records a live owner", () =>
    withLocal(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-live-lease", "{}")
      expect(yield* store.claimAndOwn("run-live-lease", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
      const nowMs = yield* Clock.currentTimeMillis
      // The lease renews behind the store's back, so the row looks stale
      // while the strategy still records a live owner.
      expect((yield* consensus.heartbeat("run-live-lease", ownerA, nowMs))._tag).toBe("Renewed")
      const stale: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: 0 }
      expect(yield* store.steal("run-live-lease", stale, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
        _tag: "SnapshotChanged"
      })
    })))

  it.effect("recoverClaim reports ClaimChanged when the lease's claim moved on", () =>
    withLocal(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-claim-gone", "{}")
      expect(yield* store.claim("run-claim-gone", pending, ownerA, 0)).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      yield* consensus.release("run-claim-gone", ownerA)
      yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.recoverClaim("run-claim-gone", ownerA, 0, observer, nowMs, evidence(ownerA, observer, nowMs))
      ).toEqual({ _tag: "ClaimChanged" })
    })))

  it.effect("transitionOwned reports FenceLost when the row claims an owner the lease does not", () =>
    withLocal(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-row-only', 'running', 0, ${ownerA.hostId}, ${ownerA.pid}, ${ownerA.nonce}, 0, '{}')
      `
      expect(yield* store.transitionOwned("run-row-only", ownerA, "completed")).toEqual({ _tag: "FenceLost" })
    })))
})

describe("a failing strategy is a persistence failure, never a silent grant", () => {
  const withSql = <A, E>(
    body: Effect.Effect<
      A,
      E,
      Consensus.Consensus | Journal | RunStore | DurableWriter.DurableWriter | SqlClient.SqlClient
    >
  ) =>
    Effect.scoped(
      body.pipe(Effect.provide(stackFor(SqlConsensus.layer)), Effect.provide(TestClock.layer()))
    )

  it.effect("claim and transitionOwned surface the strategy's storage failure", () =>
    withSql(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("run-broken-lease", "{}")
      yield* store.create("run-broken-claim", "{}")
      expect(yield* store.claimAndOwn("run-broken-lease", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      yield* sql`DROP TABLE flows_consensus_leases`
      const claimFailure = yield* Effect.flip(store.claim("run-broken-claim", pending, ownerB, 1))
      expect(claimFailure.code).toBe("persistence_failed")
      const transitionFailure = yield* Effect.flip(store.transitionOwned("run-broken-lease", ownerA, "completed"))
      expect(transitionFailure.code).toBe("persistence_failed")
    })))
})
