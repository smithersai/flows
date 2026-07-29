import * as Jj from "@flows/host/Jj"
import { CacheStore, Journal, RunStore } from "@flows/journal"
import type * as JournalEvent from "@flows/journal/JournalEvent"
import type { OwnerId } from "@flows/journal/Ownership"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/EffectHandlerRegistry.ts"
import type { LineageEdge } from "../src/Frame.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as Rewind from "../src/Rewind.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner: OwnerId = { hostId: "test-host", pid: 20, nonce: "rollback-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const runError = () =>
  new RunStore.RunStoreError({
    code: "not_found_row",
    method: "get",
    message: "run missing",
    cause: "get"
  })

const makeRuns = (
  initial: RunStore.RunRow
): RunStore.Service & { readonly state: () => RunStore.RunRow } => {
  let row = { ...initial }
  const service = RunStore.makeNoop({
    get: () => Effect.succeed({ ...row }),
    claim: (_runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        if (row.claim !== null) return { _tag: "AlreadyClaimed" as const }
        row.claim = claimant
        row.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (_runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        if (row.claim?.nonce !== claimant.nonce || row.claimedAtMs !== claimedAtMs) {
          return { _tag: "ClaimLost" as const }
        }
        row.status = "running"
        row.owner = claimant
        row.heartbeatAtMs = claimedAtMs
        row.claim = null
        row.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    abandonClaim: () => Effect.succeed({ _tag: "Abandoned" as const }),
    transitionOwned: (_runId, currentOwner, status, stateJson) =>
      Effect.sync(() => {
        if (row.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        row.status = status
        row.stateJson = stateJson ?? row.stateJson
        if (status !== "running") {
          row.owner = null
          row.heartbeatAtMs = null
          row.claim = null
          row.claimedAtMs = null
        }
        return { _tag: "Transitioned" as const }
      }),
    create: () => Effect.fail(runError())
  })
  return Object.assign(service, { state: () => ({ ...row }) })
}

const runRow = (): RunStore.RunRow => ({
  runId: "run",
  status: "suspended",
  createdAtMs: 1,
  startedAtMs: 2,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  stateJson: "{\"cursor\":9}"
})

const stored = (
  seq: number,
  eventType: string,
  payload: unknown
): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId: "run/root",
  payload: { eventType, payload, meta: { lineageId: "run/root" } }
})

const crossed = (
  id: string,
  kind: string,
  tier: EffectBoundary.EffectTier
): Omit<EffectBoundary.EffectRecord, "seq"> => ({
  id,
  kind,
  tier,
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  ...(tier === "compensable" ? { changeId: "target" } : {}),
  durableBoundary: true,
  providerStream: false
})

const records = (): ReadonlyArray<MemoryTimeTravelStore.JournalRecord> => [
  stored(0, "baseline", {}),
  stored(1, EffectBoundary.eventType, { effect: crossed("send", "send", "irreversible") }),
  stored(2, EffectBoundary.eventType, { effect: crossed("workspace", "fs-write", "compensable") })
]

const edge: LineageEdge = {
  parentRunId: "run",
  parentSeq: 1,
  childRunId: "run/root/attached",
  kind: "child",
  attached: true
}

const makeJournal = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>
): Journal.Service =>
  Journal.makeNoop({
    entries: ({ runId, after, limit }) =>
      Effect.sync(() => {
        const all = store.state().records
          .filter((record) => record.runId === runId && record.seq > (after ?? -1))
          .sort((left, right) => left.seq - right.seq)
        const page = all.slice(0, limit)
        return {
          entries: page.map((record) => {
            const value = record.payload as {
              readonly eventType: string
              readonly payload: unknown
              readonly meta: unknown
            }
            return {
              runId: record.runId as JournalEvent.RunId,
              seq: record.seq as JournalEvent.Seq,
              eventId: record.eventId,
              sourceId: "rollback" as JournalEvent.SourceId,
              sourceSeq: record.seq as JournalEvent.SourceSeq,
              emittedAtMs: record.seq,
              eventType: value.eventType,
              payload: value.payload,
              meta: value.meta
            } as JournalEvent.Entry
          }),
          hasMore: all.length > page.length
        }
      })
  })

const makeJj = () => {
  let pointer = "current"
  const service = Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: pointer }),
    restore: (changeId) =>
      Effect.sync(() => {
        pointer = changeId
      })
  })
  return { service, pointer: () => pointer }
}

const failureSteps: ReadonlyArray<Rewind.RewindStep> = [
  "claim-run",
  "rate-limit",
  "write-audit",
  "load-suffix",
  "assess-boundary",
  "compensate-effects",
  "restore-workspace",
  "archive-and-truncate"
]

describe("Rewind rollback parity row 4", () => {
  for (const step of failureSteps) {
    it(`fault injection "${step}" restores journal, run, lineage, jj, and receipts while retaining the audit`, async () => {
      const timeStore = MemoryTimeTravelStore.make({
        records: records(),
        edges: [edge],
        snapshots: [{ runId: "run", frame, changeId: "target" }]
      })
      const runs = makeRuns(runRow())
      const jj = makeJj()
      const external = ["sent"]
      const handler: EffectHandlerRegistry.Handler = {
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "message remains sent",
        revert: () =>
          Effect.sync(() => {
            const value = external.pop()
            return { value }
          }),
        rollback: (_effect, receipt) =>
          Effect.sync(() => {
            external.push(String((receipt as { readonly value: string }).value))
          })
      }
      const registry = Effect.runSync(EffectHandlerRegistry.make([handler]))
      const storeBefore = timeStore.state()
      const runBefore = runs.state()
      const failure = await Effect.runPromise(
        Effect.flip(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: `audit-${step}`,
            hooks: {
              beforeStep: (current) =>
                current === step
                  ? Effect.fail(new Error(`injected ${step}`))
                  : Effect.void
            }
          }).pipe(
            Effect.provide(Layer.succeed(TimeTravelStore, timeStore)),
            Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
            Effect.provide(Layer.succeed(Journal.Journal, makeJournal(timeStore))),
            Effect.provide(CacheStore.layerNoop({
              get: () => Effect.succeed(Option.none())
            })),
            Effect.provide(Layer.succeed(Jj.Jj, jj.service)),
            Effect.provide(Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, registry))
          )
        )
      )
      const storeAfter = timeStore.state()

      expect(failure.code).toBe("unknown")
      expect(storeAfter.records).toEqual(storeBefore.records)
      expect(storeAfter.archived).toEqual(storeBefore.archived)
      expect(storeAfter.edges).toEqual(storeBefore.edges)
      expect(storeAfter.receipts).toEqual(storeBefore.receipts)
      expect(storeAfter.snapshots).toEqual(storeBefore.snapshots)
      expect(runs.state()).toEqual(runBefore)
      expect(jj.pointer()).toBe("current")
      expect(external).toEqual(["sent"])
      expect(storeAfter.audits).toHaveLength(1)
      expect(storeAfter.audits[0]).toMatchObject({
        id: `audit-${step}`,
        status: "failed"
      })
      expect(storeAfter.audits[0]?.status).not.toBe("in_progress")
    })
  }
})
