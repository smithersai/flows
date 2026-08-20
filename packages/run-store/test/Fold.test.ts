import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Consensus from "@smthrs/journal/Consensus"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Fold from "../src/Fold.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import type { RunRow, RunSnapshot } from "../src/RunStore.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrationsLayer = Layer.effectDiscard(DatabaseMigrations.run([JournalMigrations.set, Migrations.set]))

const stackFor = (
  strategy: Layer.Layer<Consensus.Consensus, never, DurableWriter.DurableWriter | SqlClient.SqlClient>
) =>
  Layer.mergeAll(
    RunStoreLive.layerWith,
    AttemptStore.layer
  ).pipe(
    Layer.provideMerge(
      SqlJournal.layerWith({ capacity: 128, overflow: "reject" }).pipe(Layer.provideMerge(strategy))
    ),
    Layer.provideMerge(Layer.provideMerge(migrationsLayer, TestDatabase.layer))
  )

const withStack = <A, E>(
  strategy: Layer.Layer<Consensus.Consensus, never, DurableWriter.DurableWriter | SqlClient.SqlClient>,
  body: Effect.Effect<
    A,
    E,
    | Consensus.Consensus
    | Journal
    | RunStore
    | AttemptStore.AttemptStore
    | DurableWriter.DurableWriter
    | SqlClient.SqlClient
  >
) => body.pipe(Effect.provide(stackFor(strategy)), Effect.provide(TestClock.layer()), Effect.scoped)

const ownerA: OwnerId = { hostId: "fold-host-a", pid: 101, nonce: "fold-owner-a" }
const ownerB: OwnerId = { hostId: "fold-host-b", pid: 202, nonce: "fold-owner-b" }

interface MaterializedRun {
  readonly runId: string
  readonly status: string
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly ownerHostId: string | null
  readonly ownerPid: number | null
  readonly ownerNonce: string | null
  readonly heartbeatAtMs: number | null
  readonly claimHostId: string | null
  readonly claimPid: number | null
  readonly claimNonce: string | null
  readonly claimedAtMs: number | null
  readonly parentRunId: string | null
  readonly cancelRequestedAtMs: number | null
  readonly waitingReason: string | null
  readonly waitingWakeAtMs: number | null
  readonly waitingToken: string | null
  readonly lineageId: string | null
  readonly roundOrdinal: number | null
  readonly stateJson: string
}

interface MaterializedAttempt {
  readonly runId: string
  readonly stepKeyDigest: string
  readonly attempt: number
  readonly state: string
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
  readonly heartbeatAtMs: number | null
  readonly checkpointJson: string | null
  readonly errorJson: string | null
  readonly outcomeJson: string | null
  readonly metaJson: string
}

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const owner = (hostId: string | null, pid: number | null, nonce: string | null) =>
  hostId === null || pid === null || nonce === null ? null : { hostId, pid, nonce }

const materialized = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const runs = yield* sql<MaterializedRun>`
    SELECT
      run_id AS "runId",
      status,
      created_at_ms AS "createdAtMs",
      started_at_ms AS "startedAtMs",
      finished_at_ms AS "finishedAtMs",
      owner_host_id AS "ownerHostId",
      owner_pid AS "ownerPid",
      owner_nonce AS "ownerNonce",
      heartbeat_at_ms AS "heartbeatAtMs",
      claim_host_id AS "claimHostId",
      claim_pid AS "claimPid",
      claim_nonce AS "claimNonce",
      claimed_at_ms AS "claimedAtMs",
      parent_run_id AS "parentRunId",
      cancel_requested_at_ms AS "cancelRequestedAtMs",
      waiting_reason AS "waitingReason",
      waiting_wake_at_ms AS "waitingWakeAtMs",
      waiting_token AS "waitingToken",
      lineage_id AS "lineageId",
      round_ordinal AS "roundOrdinal",
      state_json AS "stateJson"
    FROM flows_runs
    ORDER BY run_id
  `
  const attempts = yield* sql<MaterializedAttempt>`
    SELECT
      run_id AS "runId",
      step_key_digest AS "stepKeyDigest",
      attempt,
      state,
      started_at_ms AS "startedAtMs",
      finished_at_ms AS "finishedAtMs",
      heartbeat_at_ms AS "heartbeatAtMs",
      checkpoint_json AS "checkpointJson",
      error_json AS "errorJson",
      outcome_json AS "outcomeJson",
      meta_json AS "metaJson"
    FROM flows_attempts
    ORDER BY run_id, step_key_digest, attempt
  `
  return { attempts, runs }
})

const materializedComparable = (rows: {
  readonly runs: ReadonlyArray<MaterializedRun>
  readonly attempts: ReadonlyArray<MaterializedAttempt>
}) => ({
  attempts: rows.attempts.map((row) => ({
    runId: row.runId,
    stepKeyDigest: row.stepKeyDigest,
    attempt: row.attempt,
    state: row.state,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    checkpointJson: row.checkpointJson,
    errorJson: row.errorJson,
    outcomeJson: row.outcomeJson,
    metaJson: row.metaJson
  })),
  runs: rows.runs.map((row) => ({
    runId: row.runId,
    status: row.status,
    createdAtMs: row.createdAtMs,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    owner: owner(row.ownerHostId, row.ownerPid, row.ownerNonce),
    claim: owner(row.claimHostId, row.claimPid, row.claimNonce),
    claimedAtMs: row.claimedAtMs,
    parentRunId: row.parentRunId,
    cancelRequestedAtMs: row.cancelRequestedAtMs,
    waitingReason: row.waitingReason,
    waitingWakeAtMs: row.waitingWakeAtMs,
    waitingToken: row.waitingToken,
    lineageId: row.lineageId,
    roundOrdinal: row.roundOrdinal,
    stateJson: row.stateJson
  }))
})

const foldComparable = (state: Fold.State) => ({
  attempts: Array.from(state.attempts.values())
    .sort((left, right) =>
      left.runId.localeCompare(right.runId) ||
      left.stepKeyDigest.localeCompare(right.stepKeyDigest) ||
      left.attempt - right.attempt
    ),
  runs: Array.from(state.runs.values())
    .sort((left, right) => left.runId.localeCompare(right.runId))
    .map((row) => ({
      runId: row.runId,
      status: row.status,
      createdAtMs: row.createdAtMs,
      startedAtMs: row.startedAtMs,
      finishedAtMs: row.finishedAtMs,
      owner: row.owner,
      claim: row.claim,
      claimedAtMs: row.claimedAtMs,
      parentRunId: row.parentRunId,
      cancelRequestedAtMs: row.cancelRequestedAtMs,
      waitingReason: row.waitingReason,
      waitingWakeAtMs: row.waitingWakeAtMs,
      waitingToken: row.waitingToken,
      lineageId: row.lineageId,
      roundOrdinal: row.roundOrdinal,
      stateJson: row.stateJson
    }))
})

const entriesFor = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    const pages = yield* Effect.forEach(runIds, (runId) =>
      journal.entries({ runId: runId as JournalEvent.RunId, limit: 100 }))
    return pages.flatMap((page) =>
      page.entries
    ).filter((entry) =>
      entry.eventType.startsWith("flows.run.") ||
      entry.eventType.startsWith("flows.attempt.") ||
      entry.eventType.startsWith("flows.consensus.")
    )
  })

const attemptEventCount = (runId: string) =>
  Effect.map(
    entriesFor([runId]),
    (entries) => entries.filter((entry) => entry.eventType.startsWith("flows.attempt.")).length
  )

it.effect("exposes the public reducer helpers over a fresh fold state", () =>
  Effect.gen(function*() {
    const state = Fold.initial()
    const reduced = yield* Fold.reduce(state, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 0 as JournalEvent.Seq,
      eventId: "reducer-run:0",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 0 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: "flows.run.created",
      payload: { createdAtMs: 0, stateJson: "{}", lineageId: "reducer-run/root" },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 1 as JournalEvent.Seq,
      eventId: "reducer-run:1",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 1 as JournalEvent.SourceSeq,
      emittedAtMs: 1,
      eventType: "flows.run.transitioned",
      payload: { status: "suspended", atMs: 1, waiting: { reason: "gate", wakeAt: 2, token: "tok" } },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 2 as JournalEvent.Seq,
      eventId: "reducer-run:2",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 2 as JournalEvent.SourceSeq,
      emittedAtMs: 2,
      eventType: "flows.run.transitioned",
      payload: { status: "suspended", atMs: 2, waiting: "invalid" },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 3 as JournalEvent.Seq,
      eventId: "reducer-run:3",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 3 as JournalEvent.SourceSeq,
      emittedAtMs: 3,
      eventType: "flows.run.transitioned",
      payload: { status: "suspended", atMs: 3, waiting: null },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 4 as JournalEvent.Seq,
      eventId: "reducer-run:4",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 4 as JournalEvent.SourceSeq,
      emittedAtMs: 4,
      eventType: "flows.consensus.claimed",
      payload: { owner: ownerA, grantedAtMs: 4 },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 5 as JournalEvent.Seq,
      eventId: "reducer-run:5",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 5 as JournalEvent.SourceSeq,
      emittedAtMs: 5,
      eventType: "flows.consensus.expired",
      payload: { owner: ownerB, grantedAtMs: 5 },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 6 as JournalEvent.Seq,
      eventId: "reducer-run:6",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 6 as JournalEvent.SourceSeq,
      emittedAtMs: 6,
      eventType: "flows.consensus.expired",
      payload: { owner: ownerA, grantedAtMs: 6 },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 7 as JournalEvent.Seq,
      eventId: "reducer-run:7",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 7 as JournalEvent.SourceSeq,
      emittedAtMs: 7,
      eventType: "flows.attempt.put",
      payload: {
        stepKeyDigest: "step",
        attempt: 0,
        state: "running",
        startedAtMs: 7,
        checkpoint: { cursor: 1 },
        meta: { reducer: true }
      },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 8 as JournalEvent.Seq,
      eventId: "reducer-run:8",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 8 as JournalEvent.SourceSeq,
      emittedAtMs: 8,
      eventType: "flows.attempt.checkpointed",
      payload: { stepKeyDigest: "step", attempt: 0, checkpoint: { cursor: 2 } },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 9 as JournalEvent.Seq,
      eventId: "reducer-run:9",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 9 as JournalEvent.SourceSeq,
      emittedAtMs: 9,
      eventType: "flows.attempt.finished",
      payload: {
        stepKeyDigest: "step",
        attempt: 0,
        state: "completed",
        finishedAtMs: 9,
        error: null,
        outcome: { ok: true },
        meta: { done: true }
      },
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.reduce(reduced, {
      runId: "reducer-run" as JournalEvent.RunId,
      seq: 10 as JournalEvent.Seq,
      eventId: "reducer-run:10",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 10 as JournalEvent.SourceSeq,
      emittedAtMs: 10,
      eventType: "custom",
      payload: null,
      meta: { lineageId: "reducer-run/root" }
    } as JournalEvent.Entry)
    yield* Fold.runProjection().reduce(new Map(), {
      runId: "projection-run" as JournalEvent.RunId,
      seq: 0 as JournalEvent.Seq,
      eventId: "projection-run:0",
      sourceId: "fold-test" as JournalEvent.SourceId,
      sourceSeq: 0 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: "flows.run.created",
      payload: null,
      meta: {}
    } as JournalEvent.Entry)

    expect(reduced.runs.get("reducer-run")).toMatchObject({
      runId: "reducer-run",
      status: "suspended",
      claim: null,
      stateJson: "{}"
    })
  }))

const suite = (
  name: string,
  strategy: Layer.Layer<Consensus.Consensus, never, DurableWriter.DurableWriter | SqlClient.SqlClient>
) => {
  describe(`Fold with ${name}`, () => {
    it.effect("rebuilds lifecycle, cancellation, terminal, heartbeat, and attempt mutations from the journal", () =>
      withStack(
        strategy,
        Effect.gen(function*() {
          const runs = yield* RunStore
          const attempts = yield* AttemptStore.AttemptStore

          yield* runs.create("fold-run", "{\"phase\":\"created\"}", {
            lineageId: "fold-lineage",
            roundOrdinal: 0
          })
          expect(yield* runs.claimAndOwn("fold-run", snapshot(yield* runs.get("fold-run")), ownerA, 1)).toEqual({
            _tag: "Activated"
          })
          expect(yield* runs.transitionOwned("fold-run", ownerA, "suspended", "{\"phase\":\"suspended\"}")).toEqual({
            _tag: "Transitioned"
          })
          expect(yield* runs.claimAndOwn("fold-run", snapshot(yield* runs.get("fold-run")), ownerB, 3)).toEqual({
            _tag: "Activated"
          })
          expect(yield* runs.requestCancel("fold-run", 4)).toEqual({ _tag: "CancelRequested", requestedAtMs: 4 })

          const attempt0 = {
            runId: "fold-run",
            stepKeyDigest: "step-0",
            attempt: 0,
            state: "running",
            startedAtMs: 10,
            heartbeatAtMs: 11,
            meta: { phase: "inserted" }
          }
          expect(yield* attempts.put(attempt0, ownerB)).toEqual({ _tag: "Inserted" })
          const afterInsert = yield* attemptEventCount("fold-run")
          expect(yield* attempts.put(attempt0, ownerB)).toEqual({ _tag: "ExistingSame" })
          expect(yield* attempts.put({ ...attempt0, meta: { phase: "conflict" } }, ownerB)).toEqual({
            _tag: "Conflict"
          })
          expect(yield* attemptEventCount("fold-run")).toBe(afterInsert)

          expect(yield* attempts.heartbeat("fold-run", "step-0", 0, ownerB, 12, { cursor: 2 })).toEqual({
            _tag: "Updated"
          })
          const afterCheckpoint = yield* attemptEventCount("fold-run")
          expect(yield* attempts.heartbeat("fold-run", "step-0", 0, ownerB, 13)).toEqual({ _tag: "Updated" })
          expect(yield* attemptEventCount("fold-run")).toBe(afterCheckpoint)
          expect(
            yield* attempts.patch({
              runId: "fold-run",
              stepKeyDigest: "step-0",
              attempt: 0
            }, {
              outcome: { partial: true },
              meta: { phase: "patched" }
            }, ownerB)
          ).toEqual({ _tag: "Patched" })
          expect(
            yield* attempts.finish({
              runId: "fold-run",
              stepKeyDigest: "step-0",
              attempt: 0,
              state: "completed",
              finishedAtMs: 20,
              outcome: { ok: true }
            }, ownerB)
          ).toEqual({ _tag: "Finished" })

          const attempt1 = { runId: "fold-run", stepKeyDigest: "step-1", attempt: 0 }
          expect(
            yield* attempts.put({ ...attempt1, state: "running", startedAtMs: 21, meta: { phase: "second" } }, ownerB)
          )
            .toEqual({ _tag: "Inserted" })
          expect(yield* attempts.patch(attempt1, { outcome: { partial: "kept" } }, ownerB)).toEqual({ _tag: "Patched" })
          expect(yield* attempts.finish({ ...attempt1, state: "failed", finishedAtMs: 22 }, ownerB)).toEqual({
            _tag: "Finished"
          })

          expect(
            yield* runs.transitionOwned("fold-run", ownerB, "completed", "{\"phase\":\"done\"}", {
              cancelRequested: "present"
            })
          ).toEqual({ _tag: "Transitioned" })
          const beforeLatePatch = yield* attemptEventCount("fold-run")
          expect(
            yield* attempts.patch({ runId: "fold-run", stepKeyDigest: "step-0", attempt: 0 }, {
              meta: { late: true }
            }, ownerB)
          ).toEqual({ _tag: "FenceLost" })
          expect(yield* attemptEventCount("fold-run")).toBe(beforeLatePatch)

          yield* runs.create("heartbeat-run", "{}")
          expect(yield* runs.claimAndOwn("heartbeat-run", snapshot(yield* runs.get("heartbeat-run")), ownerA, 30))
            .toEqual(
              { _tag: "Activated" }
            )
          expect(yield* runs.heartbeat("heartbeat-run", ownerA, 50)).toEqual({ _tag: "Updated" })

          for (const [runId, status] of [["fold-failed", "failed"], ["fold-cancelled", "cancelled"]] as const) {
            yield* runs.create(runId, "{}")
            expect(yield* runs.claimAndOwn(runId, snapshot(yield* runs.get(runId)), ownerA, 60)).toEqual({
              _tag: "Activated"
            })
            expect(yield* runs.transitionOwned(runId, ownerA, status, JSON.stringify({ status }))).toEqual({
              _tag: "Transitioned"
            })
          }

          const entries = yield* entriesFor(["fold-run", "heartbeat-run", "fold-failed", "fold-cancelled"])
          expect(
            entries.every((entry) =>
              (entry.meta as { readonly lineageId?: string }).lineageId === `${entry.runId}/root`
            )
          ).toBe(true)
          const folded = yield* Fold.foldEntries(entries)
          const live = yield* materialized
          expect(materializedComparable(live)).toEqual(foldComparable(folded))
          expect(live.attempts.find((row) => row.stepKeyDigest === "step-0")?.heartbeatAtMs).toBe(13)
          const liveHeartbeat = live.runs.find((row) => row.runId === "heartbeat-run")?.heartbeatAtMs
          const foldedHeartbeat = folded.runs.get("heartbeat-run")?.heartbeatAtMs
          expect(liveHeartbeat).toBe(50)
          expect(foldedHeartbeat).toBe(30)
          expect(liveHeartbeat ?? 0).toBeGreaterThanOrEqual(foldedHeartbeat ?? Number.MAX_SAFE_INTEGER)

          yield* Fold.rebuild
          const rebuilt = yield* materialized
          expect(materializedComparable(rebuilt)).toEqual(foldComparable(folded))
          expect(rebuilt.attempts.find((row) => row.stepKeyDigest === "step-0")?.heartbeatAtMs).toBeNull()
          expect(rebuilt.runs.find((row) => row.runId === "heartbeat-run")?.heartbeatAtMs).toBe(
            folded.runs.get("heartbeat-run")?.heartbeatAtMs
          )
        })
      ))

    it.effect("rebuilds a compacted run from the snapshot barrier", () =>
      withStack(
        strategy,
        Effect.gen(function*() {
          const runs = yield* RunStore
          const journal = yield* Journal

          yield* runs.create("compacted-run", "{\"phase\":\"created\"}", {
            lineageId: "compacted-run/root",
            roundOrdinal: 0
          })
          const snapshotReceipt = yield* journal.emitDurable(
            new JournalEvent.Input({
              runId: "compacted-run" as JournalEvent.RunId,
              sourceId: "fold-test/snapshot" as JournalEvent.SourceId,
              sourceSeq: 1 as JournalEvent.SourceSeq,
              eventType: "flows.run.snapshot",
              payload: {
                status: "pending",
                createdAtMs: 0,
                stateJson: "{\"phase\":\"created\"}",
                lineageId: "compacted-run/root",
                roundOrdinal: 0
              },
              meta: { lineageId: "compacted-run/root" }
            })
          )
          expect(snapshotReceipt._tag).toBe("Accepted")
          if (snapshotReceipt._tag !== "Accepted") return
          yield* journal.checkpoint({
            runId: "compacted-run" as JournalEvent.RunId,
            seq: snapshotReceipt.seq,
            state: null
          })
          const compacted = yield* journal.compact({ runId: "compacted-run" as JournalEvent.RunId })
          expect(compacted.deleted).toBeGreaterThan(0)

          yield* Fold.rebuild
          const rebuilt = yield* materialized
          expect(rebuilt.runs.find((row) => row.runId === "compacted-run")).toMatchObject({
            runId: "compacted-run",
            status: "pending",
            stateJson: "{\"phase\":\"created\"}"
          })
        })
      ))
  })
}

suite("Consensus.layerLocal", Consensus.layerLocal)
suite("SqlConsensus.layer", SqlConsensus.layer)
