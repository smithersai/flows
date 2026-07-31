import { Database, TestDatabase } from "@smithers/database"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import { heartbeatInterval, heartbeatLoop, type LivenessEvidence, type OwnerId } from "../src/Ownership.ts"
import { type RunRow, type RunSnapshot, type RunStatus, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const migrated = <A, E>(effect: Effect.Effect<A, E, Database.Database | RunStore>) =>
  run(
    effect.pipe(
      Effect.provide(RunStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer),
      Effect.provide(TestClock.layer())
    )
  )

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }
const ownerC: OwnerId = { hostId: "host-b", pid: 303, nonce: "owner-c" }
const expected: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const activateNew = (store: RunStoreLive.Service, runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    const pending = yield* store.get(runId)
    const expected = snapshot(pending)
    const claimedAtMs = yield* Clock.currentTimeMillis
    expect(yield* store.claim(runId, expected, owner, claimedAtMs)).toEqual({ _tag: "Claimed", claimedAtMs })
    expect(yield* store.activate(runId, owner, claimedAtMs, expected)).toEqual({ _tag: "Activated" })
    return yield* store.get(runId)
  })

const staleEvidence = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: expectedOwner.hostId === claimant.hostId
    ? "same-host-pid-dead"
    : "cross-host-unreachable-stale"
})

describe("RunStore", () => {
  it("round-trips a newly created run", async () => {
    const row = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-round-trip", "{\"cursor\":1}")
      return yield* store.get("run-round-trip")
    }))

    expect(row).toEqual({
      runId: "run-round-trip",
      status: "pending",
      createdAtMs: 0,
      startedAtMs: null,
      finishedAtMs: null,
      owner: null,
      heartbeatAtMs: null,
      claim: null,
      claimedAtMs: null,
      stateJson: "{\"cursor\":1}"
    })
  })

  it("returns typed errors for invalid, duplicate, missing, and corrupt runs", async () => {
    const codes = await migrated(Effect.gen(function*() {
      const database = yield* Database.Database
      const store = yield* RunStore
      const empty = yield* Effect.flip(store.create("", "{}"))
      const invalidJson = yield* Effect.flip(store.create("invalid-json", "not-json"))
      yield* store.create("duplicate", "{}")
      const duplicate = yield* Effect.flip(store.create("duplicate", "{}"))
      const missing = yield* Effect.flip(store.get("missing"))

      yield* store.create("corrupt-schema", "{}")
      yield* database.sql`UPDATE flows_runs SET created_at_ms = 'bad' WHERE run_id = 'corrupt-schema'`
      const corruptSchema = yield* Effect.flip(store.get("corrupt-schema"))

      yield* store.create("corrupt-owner", "{}")
      yield* database.sql`PRAGMA ignore_check_constraints = ON`
      yield* database.sql`
        UPDATE flows_runs
        SET owner_host_id = 'host', owner_pid = 1, owner_nonce = NULL
        WHERE run_id = 'corrupt-owner'
      `
      const corruptOwner = yield* Effect.flip(store.get("corrupt-owner"))

      yield* store.create("corrupt-heartbeat", "{}")
      yield* database.sql`
        UPDATE flows_runs SET heartbeat_at_ms = 1 WHERE run_id = 'corrupt-heartbeat'
      `
      const corruptHeartbeat = yield* Effect.flip(store.get("corrupt-heartbeat"))

      yield* store.create("corrupt-running-owner", "{}")
      yield* database.sql`
        UPDATE flows_runs
        SET status = 'running', heartbeat_at_ms = 1
        WHERE run_id = 'corrupt-running-owner'
      `
      const corruptRunningOwner = yield* Effect.flip(store.get("corrupt-running-owner"))

      yield* store.create("corrupt-claim", "{}")
      yield* database.sql`
        UPDATE flows_runs SET claim_host_id = 'host' WHERE run_id = 'corrupt-claim'
      `
      const corruptClaim = yield* Effect.flip(store.get("corrupt-claim"))

      yield* store.create("corrupt-claim-time", "{}")
      yield* database.sql`
        UPDATE flows_runs SET claimed_at_ms = 1 WHERE run_id = 'corrupt-claim-time'
      `
      const corruptClaimTime = yield* Effect.flip(store.get("corrupt-claim-time"))

      yield* store.create("corrupt-complete-claim", "{}")
      yield* database.sql`
        UPDATE flows_runs
        SET claim_host_id = 'host', claim_pid = 1, claim_nonce = 'nonce'
        WHERE run_id = 'corrupt-complete-claim'
      `
      const corruptCompleteClaim = yield* Effect.flip(store.get("corrupt-complete-claim"))

      yield* store.create("corrupt-json", "{}")
      yield* database.sql`
        UPDATE flows_runs SET state_json = 'not-json' WHERE run_id = 'corrupt-json'
      `
      const corruptJson = yield* Effect.flip(store.get("corrupt-json"))
      yield* database.sql`PRAGMA ignore_check_constraints = OFF`
      yield* database.sql`DROP TABLE flows_runs`
      const persistence = yield* Effect.flip(store.create("missing-table", "{}"))

      return [
        empty,
        invalidJson,
        duplicate,
        missing,
        corruptSchema,
        corruptOwner,
        corruptHeartbeat,
        corruptRunningOwner,
        corruptClaim,
        corruptClaimTime,
        corruptCompleteClaim,
        corruptJson,
        persistence
      ].map((failure) => failure.code)
    }))

    expect(codes).toEqual([
      "invalid_run",
      "invalid_run",
      "constraint",
      "not_found_row",
      "decode_failed",
      "decode_failed",
      "decode_failed",
      "decode_failed",
      "decode_failed",
      "decode_failed",
      "decode_failed",
      "decode_failed",
      "persistence_failed"
    ])
  })

  it("allows exactly one of two concurrent claimants to claim one snapshot", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-concurrent", "{}")
      const expected = snapshot(yield* store.get("run-concurrent"))
      const nowMs = yield* Clock.currentTimeMillis
      return yield* Effect.all(
        [
          store.claim("run-concurrent", expected, ownerA, nowMs),
          store.claim("run-concurrent", expected, ownerB, nowMs)
        ],
        { concurrency: "unbounded" }
      )
    }))

    expect(outcomes.filter((outcome) => outcome._tag === "Claimed")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome._tag !== "Claimed")).toHaveLength(1)
    expect(["AlreadyClaimed", "SnapshotChanged"]).toContain(
      outcomes.find((outcome) => outcome._tag !== "Claimed")?._tag
    )
  })

  it("rejects an ordinary claim while the recorded heartbeat is fresh", async () => {
    const outcome = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const running = yield* activateNew(store, "run-fresh-claim", ownerA)
      return yield* store.claim(
        running.runId,
        snapshot(running),
        ownerB,
        yield* Clock.currentTimeMillis
      )
    }))

    expect(outcome).toEqual({ _tag: "HeartbeatFresh" })
  })

  it("classifies missing and already-held claims", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const missing = yield* store.claim("missing", expected, ownerA, 0)
      yield* store.create("claimed", "{}")
      const pending = snapshot(yield* store.get("claimed"))
      yield* store.claim("claimed", pending, ownerA, 0)
      const alreadyClaimed = yield* store.claim("claimed", pending, ownerB, 0)
      return { missing, alreadyClaimed }
    }))

    expect(outcomes).toEqual({
      missing: { _tag: "NotFound" },
      alreadyClaimed: { _tag: "AlreadyClaimed" }
    })
  })

  it("recovers an exact stale claim only after liveness evidence confirms its claimant is dead", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("stale-claim", "{}")
      const pending = snapshot(yield* store.get("stale-claim"))
      expect(yield* store.claim("stale-claim", pending, ownerA, 0)).toEqual({
        _tag: "Claimed",
        claimedAtMs: 0
      })

      const fresh = yield* store.recoverClaim(
        "stale-claim",
        ownerA,
        0,
        ownerB,
        0,
        staleEvidence(ownerA, ownerB, 0)
      )
      yield* TestClock.adjust(Duration.seconds(31))
      const nowMs = yield* Clock.currentTimeMillis
      const stillBlocked = yield* store.claim("stale-claim", pending, ownerB, nowMs)
      const unconfirmed = yield* store.recoverClaim(
        "stale-claim",
        ownerA,
        0,
        ownerB,
        nowMs,
        staleEvidence(ownerC, ownerB, nowMs)
      )
      const recovered = yield* store.recoverClaim(
        "stale-claim",
        ownerA,
        0,
        ownerB,
        nowMs,
        staleEvidence(ownerA, ownerB, nowMs)
      )
      const changed = yield* store.recoverClaim(
        "stale-claim",
        ownerA,
        0,
        ownerB,
        nowMs,
        staleEvidence(ownerA, ownerB, nowMs)
      )
      const reclaimed = yield* store.claim("stale-claim", pending, ownerB, nowMs)
      const missing = yield* store.recoverClaim(
        "missing",
        ownerA,
        0,
        ownerB,
        nowMs,
        staleEvidence(ownerA, ownerB, nowMs)
      )
      return { fresh, stillBlocked, unconfirmed, recovered, changed, reclaimed, missing }
    }))

    expect(outcomes).toEqual({
      fresh: { _tag: "ClaimFresh" },
      stillBlocked: { _tag: "AlreadyClaimed" },
      unconfirmed: { _tag: "LivenessUnconfirmed" },
      recovered: { _tag: "Recovered" },
      changed: { _tag: "ClaimChanged" },
      reclaimed: { _tag: "Claimed", claimedAtMs: 31_000 },
      missing: { _tag: "NotFound" }
    })
  })

  it("fences delayed activation and abandonment when a claimant identity is reused", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("reused-claimant", "{}")
      const pending = snapshot(yield* store.get("reused-claimant"))
      expect(yield* store.claim("reused-claimant", pending, ownerA, 0)).toEqual({
        _tag: "Claimed",
        claimedAtMs: 0
      })

      yield* TestClock.adjust(Duration.seconds(31))
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.recoverClaim(
          "reused-claimant",
          ownerA,
          0,
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
      ).toEqual({ _tag: "Recovered" })
      expect(yield* store.claim("reused-claimant", pending, ownerA, nowMs)).toEqual({
        _tag: "Claimed",
        claimedAtMs: nowMs
      })

      const delayedActivation = yield* store.activate("reused-claimant", ownerA, 0, pending)
      const delayedAbandonment = yield* store.abandonClaim("reused-claimant", ownerA, 0)
      const stillClaimed = yield* store.get("reused-claimant")
      const currentActivation = yield* store.activate("reused-claimant", ownerA, nowMs, pending)
      return { currentActivation, delayedAbandonment, delayedActivation, stillClaimed }
    }))

    expect(result.delayedActivation).toEqual({ _tag: "ClaimLost" })
    expect(result.delayedAbandonment).toEqual({ _tag: "ClaimLost" })
    expect(result.stillClaimed.claim).toEqual(ownerA)
    expect(result.stillClaimed.claimedAtMs).toBe(31_000)
    expect(result.currentActivation).toEqual({ _tag: "Activated" })
  })

  it("requires both stale SQL state and matching liveness evidence to steal", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const fresh = yield* activateNew(store, "run-steal", ownerA)
      const freshNow = yield* Clock.currentTimeMillis
      const notStale = yield* store.steal(
        fresh.runId,
        snapshot(fresh),
        ownerC,
        freshNow,
        staleEvidence(ownerA, ownerC, freshNow)
      )

      yield* TestClock.adjust(Duration.seconds(31))
      const stale = yield* store.get(fresh.runId)
      const staleNow = yield* Clock.currentTimeMillis
      const bypass = yield* store.claim(
        stale.runId,
        snapshot(stale),
        ownerC,
        staleNow
      )
      const wrongEvidence = yield* store.steal(
        stale.runId,
        snapshot(stale),
        ownerC,
        staleNow,
        staleEvidence(ownerB, ownerC, staleNow)
      )
      const stolen = yield* store.steal(
        stale.runId,
        snapshot(stale),
        ownerC,
        staleNow,
        staleEvidence(ownerA, ownerC, staleNow)
      )
      return { notStale, bypass, wrongEvidence, stolen }
    }))

    expect(outcomes.notStale).toEqual({ _tag: "HeartbeatFresh" })
    expect(outcomes.bypass).toEqual({ _tag: "SnapshotChanged" })
    expect(outcomes.wrongEvidence).toEqual({ _tag: "SnapshotChanged" })
    expect(outcomes.stolen).toEqual({ _tag: "Claimed", claimedAtMs: 31_000 })
  })

  it("invalidates activation when the old owner heartbeats after the claim", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* activateNew(store, "run-activation-race", ownerA)
      yield* TestClock.adjust(Duration.seconds(31))
      const stale = yield* store.get("run-activation-race")
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.steal(
          stale.runId,
          snapshot(stale),
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
      ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })

      expect(yield* store.heartbeat(stale.runId, ownerA, nowMs)).toEqual({ _tag: "Updated" })
      const activation = yield* store.activate(stale.runId, ownerB, nowMs, snapshot(stale))
      return { activation, row: yield* store.get(stale.runId) }
    }))

    expect(result.activation).toEqual({ _tag: "SnapshotChanged" })
    expect(result.row.owner).toEqual(ownerA)
    expect(result.row.heartbeatAtMs).toBe(31_000)
    expect(result.row.claim).toBeNull()
    expect(result.row.claimedAtMs).toBeNull()
  })

  it("abandons only the claim and preserves the previous owner", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* activateNew(store, "run-abandon", ownerA)
      yield* TestClock.adjust(Duration.seconds(31))
      const stale = yield* store.get("run-abandon")
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.steal(
          stale.runId,
          snapshot(stale),
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
      ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })
      const outcome = yield* store.abandonClaim(stale.runId, ownerB, nowMs)
      return { outcome, row: yield* store.get(stale.runId) }
    }))

    expect(result.outcome).toEqual({ _tag: "Abandoned" })
    expect(result.row.owner).toEqual(ownerA)
    expect(result.row.heartbeatAtMs).toBe(0)
    expect(result.row.claim).toBeNull()
    expect(result.row.claimedAtMs).toBeNull()
  })

  it("reports claim losses for activation and abandonment", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const activateMissing = yield* store.activate("missing", ownerA, 0, expected)
      const abandonMissing = yield* store.abandonClaim("missing", ownerA, 0)
      yield* store.create("claimed", "{}")
      const pending = snapshot(yield* store.get("claimed"))
      yield* store.claim("claimed", pending, ownerA, 0)
      const activateWrongOwner = yield* store.activate("claimed", ownerB, 0, pending)
      const abandonWrongOwner = yield* store.abandonClaim("claimed", ownerB, 0)
      return { activateMissing, abandonMissing, activateWrongOwner, abandonWrongOwner }
    }))

    expect(outcomes).toEqual({
      activateMissing: { _tag: "ClaimLost" },
      abandonMissing: { _tag: "ClaimLost" },
      activateWrongOwner: { _tag: "ClaimLost" },
      abandonWrongOwner: { _tag: "ClaimLost" }
    })
  })

  it("fences the old owner's heartbeat after an activated steal", async () => {
    const result = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* activateNew(store, "run-heartbeat-fence", ownerA)
      yield* TestClock.adjust(Duration.seconds(31))
      const stale = yield* store.get("run-heartbeat-fence")
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.steal(
          stale.runId,
          snapshot(stale),
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
      ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })
      expect(yield* store.activate(stale.runId, ownerB, nowMs, snapshot(stale))).toEqual({ _tag: "Activated" })
      return yield* store.heartbeat(stale.runId, ownerA, nowMs + 1)
    }))

    expect(result).toEqual({ _tag: "FenceLost" })
  })

  it("reports missing heartbeat and transition targets and stale owners", async () => {
    const outcomes = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const heartbeatMissing = yield* store.heartbeat("missing", ownerA, 0)
      const transitionMissing = yield* store.transitionOwned("missing", ownerA, "failed")
      const running = yield* activateNew(store, "running-transition", ownerA)
      const keptRunning = yield* store.transitionOwned(running.runId, ownerA, "running", "{\"cursor\":1}")
      const keptState = yield* store.transitionOwned(running.runId, ownerA, "running")
      const stale = yield* store.transitionOwned(running.runId, ownerB, "failed")
      const row = yield* store.get(running.runId)
      return { heartbeatMissing, transitionMissing, keptRunning, keptState, stale, row }
    }))

    expect(outcomes.heartbeatMissing).toEqual({ _tag: "NotFound" })
    expect(outcomes.transitionMissing).toEqual({ _tag: "NotFound" })
    expect(outcomes.keptRunning).toEqual({ _tag: "Transitioned" })
    expect(outcomes.keptState).toEqual({ _tag: "Transitioned" })
    expect(outcomes.stale).toEqual({ _tag: "FenceLost" })
    expect(outcomes.row.stateJson).toBe("{\"cursor\":1}")
  })

  it("rejects invalid owned transitions", async () => {
    const failures = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      return yield* Effect.all([
        Effect.flip(store.transitionOwned("run", ownerA, "unknown" as RunStatus)),
        Effect.flip(store.transitionOwned("run", ownerA, "failed", "not-json"))
      ])
    }))

    expect(failures.map((failure) => failure.code)).toEqual(["invalid_run", "invalid_run"])
  })

  it("pulses every second and interrupts its owner when the fence is lost", async () => {
    const result = await migrated(Effect.scoped(Effect.gen(function*() {
      const store = yield* RunStore
      const running = yield* activateNew(store, "run-heartbeat-loop", ownerA)
      const started = yield* Deferred.make<void>()
      const owningFiber = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.raceFirst(Effect.never, heartbeatLoop(running.runId, ownerA))
        })
      ).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(started)
      yield* TestClock.adjust(heartbeatInterval)
      yield* Effect.yieldNow
      const pulsed = yield* store.get(running.runId)
      expect(pulsed.heartbeatAtMs).toBe(1_000)

      expect(yield* store.transitionOwned(running.runId, ownerA, "suspended")).toEqual({
        _tag: "Transitioned"
      })
      yield* TestClock.adjust(heartbeatInterval)
      yield* Effect.yieldNow
      return yield* Fiber.await(owningFiber)
    })))

    expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
  })

  it("interrupts its owner when heartbeat persistence fails", async () => {
    const failure = new RunStoreLive.RunStoreError({
      code: "persistence_failed",
      method: "heartbeat",
      message: "persistence_failed: heartbeat failed",
      cause: new Error("database unavailable")
    })
    const result = await run(
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const owningFiber = yield* Effect.scoped(
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.raceFirst(Effect.never, heartbeatLoop("run-heartbeat-error", ownerA))
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        yield* TestClock.adjust(heartbeatInterval)
        yield* Effect.yieldNow
        return yield* Fiber.await(owningFiber)
      })).pipe(
        Effect.provide(
          RunStoreLive.layerNoop({
            heartbeat: () => Effect.fail(failure)
          })
        ),
        Effect.provide(TestClock.layer())
      )
    )

    expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
  })

  it("suspends while clearing owner, heartbeat, and an in-flight claim atomically", async () => {
    const row = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* activateNew(store, "run-suspend", ownerA)
      yield* TestClock.adjust(Duration.seconds(31))
      const stale = yield* store.get("run-suspend")
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.steal(
          stale.runId,
          snapshot(stale),
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
      ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })
      expect(
        yield* store.transitionOwned(stale.runId, ownerA, "suspended", "{\"reason\":\"opaque\"}")
      ).toEqual({ _tag: "Transitioned" })
      return yield* store.get(stale.runId)
    }))

    expect(row).toMatchObject({
      status: "suspended",
      owner: null,
      heartbeatAtMs: null,
      claim: null,
      claimedAtMs: null,
      stateJson: "{\"reason\":\"opaque\"}"
    })
  })

  it("clears ownership for every terminal transition", async () => {
    const rows = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const result: Array<RunRow> = []
      const statuses: ReadonlyArray<RunStatus> = ["completed", "failed", "cancelled"]
      for (const status of statuses) {
        const runId = `run-terminal-${status}`
        yield* activateNew(store, runId, ownerA)
        expect(yield* store.transitionOwned(runId, ownerA, status)).toEqual({ _tag: "Transitioned" })
        result.push(yield* store.get(runId))
      }
      return result
    }))

    for (const row of rows) {
      expect(row.finishedAtMs).toBe(0)
      expect(row.owner).toBeNull()
      expect(row.heartbeatAtMs).toBeNull()
      expect(row.claim).toBeNull()
      expect(row.claimedAtMs).toBeNull()
    }
  })

  it("does not reclaim a terminal run", async () => {
    const outcome = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* activateNew(store, "run-terminal-claim", ownerA)
      yield* store.transitionOwned("run-terminal-claim", ownerA, "completed")
      const terminal = yield* store.get("run-terminal-claim")
      return yield* store.claim(
        terminal.runId,
        snapshot(terminal),
        ownerB,
        yield* Clock.currentTimeMillis
      )
    }))

    expect(outcome).toEqual({ _tag: "SnapshotChanged" })
  })

  it("never persists owner columns for a non-running status", async () => {
    const rows = await migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-pending-owner-invariant", "{}")
      const pending = yield* store.get("run-pending-owner-invariant")
      const result = [pending]
      for (const status of ["suspended", "completed", "failed", "cancelled"] as const) {
        const runId = `run-owner-invariant-${status}`
        yield* activateNew(store, runId, ownerA)
        yield* store.transitionOwned(runId, ownerA, status)
        result.push(yield* store.get(runId))
      }
      return result
    }))

    for (const row of rows) {
      expect(row.status).not.toBe("running")
      expect(row.owner).toBeNull()
      expect(row.heartbeatAtMs).toBeNull()
    }
  })
})
