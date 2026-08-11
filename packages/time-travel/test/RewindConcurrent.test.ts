import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import { CacheStore } from "@smthrs/step-cache"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const ownerA: OwnerId = { hostId: "test-host", pid: 30, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "test-host", pid: 31, nonce: "owner-b" }
const frame = { lineageId: "run/root", seq: 0 } as const

const makeRuns = (): RunStore.Service & { readonly state: () => RunStore.RunRow } => {
  let row: RunStore.RunRow = {
    runId: "run",
    status: "suspended",
    createdAtMs: 0,
    startedAtMs: 0,
    finishedAtMs: null,
    owner: null,
    heartbeatAtMs: null,
    claim: null,
    claimedAtMs: null,
    parentRunId: null,
    cancelRequestedAtMs: null,
    stateJson: "{}"
  }
  const service = RunStore.makeNoop({
    get: () => Effect.succeed({ ...row }),
    claim: (_runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        if (row.claim !== null) return { _tag: "AlreadyClaimed" as const }
        if (row.status === "running") return { _tag: "HeartbeatFresh" as const }
        row = { ...row, claim: claimant, claimedAtMs: nowMs }
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (_runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        if (row.claim?.nonce !== claimant.nonce || row.claimedAtMs !== claimedAtMs) {
          return { _tag: "ClaimLost" as const }
        }
        row = {
          ...row,
          status: "running",
          owner: claimant,
          heartbeatAtMs: claimedAtMs,
          claim: null,
          claimedAtMs: null,
          parentRunId: null,
          cancelRequestedAtMs: null
        }
        return { _tag: "Activated" as const }
      }),
    abandonClaim: () => Effect.succeed({ _tag: "Abandoned" as const }),
    transitionOwned: (_runId, currentOwner, status) =>
      Effect.sync(() => {
        if (row.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        row = {
          ...row,
          status,
          ...(status === "running"
            ? {}
            : {
              owner: null,
              heartbeatAtMs: null,
              claim: null,
              claimedAtMs: null,
              parentRunId: null,
              cancelRequestedAtMs: null
            })
        }
        return { _tag: "Transitioned" as const }
      })
  })
  return Object.assign(service, { state: () => ({ ...row }) })
}

describe("Rewind concurrency", () => {
  it("returns typed busy to a second rewind while the first holds the activated RunStore CAS", async () => {
    const store = MemoryTimeTravelStore.make({
      records: [{
        runId: "run",
        seq: 0,
        eventId: "event-0",
        lineageId: "run/root",
        payload: { eventType: "baseline", payload: {}, meta: { lineageId: "run/root" } }
      }]
    })
    const runs = makeRuns()
    const journal = Journal.makeNoop({
      entries: ({ runId, after }) =>
        Effect.sync(() => ({
          entries: store.state().records
            .filter((record) => record.runId === runId && record.seq > (after ?? -1))
            .map((record) => {
              const value = record.payload as {
                readonly eventType: string
                readonly payload: unknown
                readonly meta: unknown
              }
              return {
                runId: record.runId as JournalEvent.RunId,
                seq: record.seq as JournalEvent.Seq,
                eventId: record.eventId,
                sourceId: "concurrent" as JournalEvent.SourceId,
                sourceSeq: record.seq as JournalEvent.SourceSeq,
                emittedAtMs: record.seq,
                eventType: value.eventType,
                payload: value.payload,
                meta: value.meta
              } as JournalEvent.Entry
            }),
          hasMore: false
        }))
    })
    const jj = Jj.makeNoop({
      snapshot: () => Effect.succeed({ changeId: "current" }),
      restore: () => Effect.void
    })
    const registry = Effect.runSync(EffectHandlerRegistry.make())
    const entered = Effect.runSync(Deferred.make<void>())
    const release = Effect.runSync(Deferred.make<void>())
    const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(
        Effect.provide(Layer.succeed(TimeTravelStore, store)),
        Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
        Effect.provide(Layer.succeed(Journal.Journal, journal)),
        Effect.provide(CacheStore.layerNoop({
          get: () => Effect.succeed(Option.none())
        })),
        Effect.provide(Layer.succeed(Jj.Jj, jj)),
        Effect.provide(Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, registry))
      )

    const first = Effect.runFork(
      provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner: ownerA,
          auditId: "audit-first",
          hooks: {
            beforeStep: (step) =>
              step === "claim-run"
                ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
                : Effect.void
          }
        })
      )
    )
    await Effect.runPromise(Deferred.await(entered))

    const second = await Effect.runPromise(
      Effect.flip(
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner: ownerB,
            auditId: "audit-second"
          })
        )
      )
    )
    expect(second.code).toBe("busy")
    expect(runs.state()).toMatchObject({ status: "running", owner: ownerA })

    await Effect.runPromise(Deferred.succeed(release, undefined))
    const firstResult = await Effect.runPromise(Fiber.join(first))
    expect(firstResult.auditId).toBe("audit-first")
    expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
    expect(store.state().audits).toMatchObject([
      { id: "audit-first", status: "completed" }
    ])
  })
})
