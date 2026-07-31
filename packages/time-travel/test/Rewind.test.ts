import * as Jj from "@smithers/host/Jj"
import { CacheStore, Journal, RunStore } from "@smithers/journal"
import type * as JournalEvent from "@smithers/journal/JournalEvent"
import type { OwnerId } from "@smithers/journal/Ownership"
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

const owner: OwnerId = { hostId: "test-host", pid: 10, nonce: "rewind-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const runError = (method: string) =>
  new RunStore.RunStoreError({
    code: "not_found_row",
    method,
    message: `${method} failed`,
    cause: method
  })

const makeRuns = (
  rows: ReadonlyArray<RunStore.RunRow>
): RunStore.Service & { readonly state: (runId: string) => RunStore.RunRow } => {
  const state = new Map(rows.map((row) => [row.runId, { ...row }]))
  const get = (runId: string) => {
    const row = state.get(runId)
    return row === undefined
      ? Effect.fail(runError("get"))
      : Effect.succeed({ ...row })
  }
  const service = RunStore.makeNoop({
    get,
    claim: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const row = state.get(runId)
        if (row === undefined) return { _tag: "NotFound" as const }
        if (row.claim !== null) return { _tag: "AlreadyClaimed" as const }
        if (row.status === "running") return { _tag: "HeartbeatFresh" as const }
        row.claim = claimant
        row.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    steal: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const row = state.get(runId)
        if (row === undefined) return { _tag: "NotFound" as const }
        if (row.claim !== null) return { _tag: "AlreadyClaimed" as const }
        row.claim = claimant
        row.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        const row = state.get(runId)
        if (
          row === undefined ||
          row.claim?.nonce !== claimant.nonce ||
          row.claimedAtMs !== claimedAtMs
        ) {
          return { _tag: "ClaimLost" as const }
        }
        row.status = "running"
        row.owner = claimant
        row.heartbeatAtMs = claimedAtMs
        row.claim = null
        row.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    abandonClaim: (runId) =>
      Effect.sync(() => {
        const row = state.get(runId)
        if (row === undefined || row.claim === null) return { _tag: "ClaimLost" as const }
        row.claim = null
        row.claimedAtMs = null
        return { _tag: "Abandoned" as const }
      }),
    transitionOwned: (runId, currentOwner, status, stateJson) =>
      Effect.sync(() => {
        const row = state.get(runId)
        if (row === undefined) return { _tag: "NotFound" as const }
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
      })
  })
  return Object.assign(service, {
    state: (runId: string) => ({ ...state.get(runId)! })
  })
}

const row = (
  runId: string,
  status: RunStore.RunStatus = "suspended"
): RunStore.RunRow => ({
  runId,
  status,
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: status === "running" ? { hostId: "child-host", pid: 11, nonce: "child-owner" } : null,
  heartbeatAtMs: status === "running" ? 0 : null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{\"cursor\":5}"
})

const boundaryRecord = (
  seq: number,
  effect: Omit<EffectBoundary.EffectRecord, "seq">
): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId: "run/root",
  payload: {
    eventType: EffectBoundary.eventType,
    payload: { effect },
    meta: { lineageId: "run/root" }
  }
})

const baseline = (): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq: 0,
  eventId: "event-0",
  lineageId: "run/root",
  payload: {
    eventType: "baseline",
    payload: {},
    meta: { lineageId: "run/root" }
  }
})

const effect = (
  id: string,
  kind: string,
  tier: EffectBoundary.EffectTier,
  status: EffectBoundary.EffectStatus = "succeeded"
): Omit<EffectBoundary.EffectRecord, "seq"> => ({
  id,
  kind,
  tier,
  status,
  runId: "run",
  lineageId: "run/root",
  ...(tier === "compensable" ? { changeId: "target" } : {}),
  durableBoundary: true,
  providerStream: false
})

const makeJournal = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>
): Journal.Service =>
  Journal.makeNoop({
    entries: ({ runId, after, limit }) =>
      Effect.sync(() => {
        const all = store.state().records
          .filter((record) => record.runId === runId && record.seq > (after ?? -1))
          .sort((left, right) => left.seq - right.seq)
        const selected = all.slice(0, limit)
        return {
          entries: selected.map((record) => {
            const stored = record.payload as {
              readonly eventType: string
              readonly payload: unknown
              readonly meta: unknown
            }
            return {
              runId: record.runId as JournalEvent.RunId,
              seq: record.seq as JournalEvent.Seq,
              eventId: record.eventId,
              sourceId: "test" as JournalEvent.SourceId,
              sourceSeq: record.seq as JournalEvent.SourceSeq,
              emittedAtMs: record.seq,
              eventType: stored.eventType,
              payload: stored.payload,
              meta: stored.meta
            } as JournalEvent.Entry
          }),
          hasMore: all.length > selected.length
        }
      })
  })

const makeJj = (initial: string) => {
  let pointer = initial
  const service = Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: pointer }),
    restore: (changeId) =>
      Effect.sync(() => {
        pointer = changeId
      })
  })
  return { service, pointer: () => pointer }
}

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: {
    readonly store: ReturnType<typeof MemoryTimeTravelStore.make>
    readonly runs: RunStore.Service
    readonly jj: Jj.Jj
    readonly handlers?: ReadonlyArray<EffectHandlerRegistry.Handler>
  }
) =>
  program.pipe(
    Effect.provide(Layer.succeed(TimeTravelStore, options.store)),
    Effect.provide(Layer.succeed(RunStore.RunStore, options.runs)),
    Effect.provide(Layer.succeed(Journal.Journal, makeJournal(options.store))),
    Effect.provide(CacheStore.layerNoop({
      get: () => Effect.succeed(Option.none())
    })),
    Effect.provide(Layer.succeed(Jj.Jj, options.jj)),
    Effect.provide(
      Layer.succeed(
        EffectHandlerRegistry.EffectHandlerRegistry,
        Effect.runSync(EffectHandlerRegistry.make(options.handlers ?? []))
      )
    )
  )

describe("Rewind", () => {
  it("compensates in reverse order, restores jj, archives the suffix, and suspends the run", async () => {
    const calls: Array<string> = []
    const external = ["first", "second"]
    const handler: EffectHandlerRegistry.Handler = {
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "message remains delivered until compensation succeeds",
      revert: (crossed) =>
        Effect.sync(() => {
          calls.push(crossed.id)
          return external.pop()
        }),
      rollback: (_crossed, receipt) =>
        Effect.sync(() => {
          external.push(String(receipt))
        })
    }
    const records = [
      baseline(),
      boundaryRecord(1, effect("send-1", "send", "irreversible")),
      boundaryRecord(2, effect("send-2", "send", "irreversible")),
      boundaryRecord(3, effect("workspace", "fs-write", "compensable"))
    ]
    const store = MemoryTimeTravelStore.make({
      records,
      snapshots: [{ runId: "run", frame, changeId: "target" }]
    })
    const runs = makeRuns([row("run")])
    const jj = makeJj("current")

    const result = await Effect.runPromise(
      provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-happy" }),
        { store, runs, jj: jj.service, handlers: [handler] }
      )
    )

    expect(calls).toEqual(["send-2", "send-1"])
    expect(external).toEqual([])
    expect(jj.pointer()).toBe("target")
    expect(store.state().records.map((record) => record.seq)).toEqual([0])
    expect(store.state().archived.map((record) => record.seq)).toEqual([1, 2, 3])
    expect(store.state().receipts).toHaveLength(2)
    expect(store.state().audits).toMatchObject([{ id: "audit-happy", status: "completed" }])
    expect(runs.state("run")).toMatchObject({ status: "suspended", owner: null, stateJson: "{\"cursor\":5}" })
    expect(result.archive.archived).toBe(3)
  })

  it("discloses a terminal detached child as an orphan warning", async () => {
    const edge: LineageEdge = {
      parentRunId: "run",
      parentSeq: 1,
      childRunId: "child",
      kind: "child",
      attached: false
    }
    const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
    const runs = makeRuns([row("run"), row("child", "completed")])
    const jj = makeJj("current")

    const result = await Effect.runPromise(
      provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-terminal" }),
        { store, runs, jj: jj.service }
      )
    )

    expect(result.warnings).toEqual([
      expect.objectContaining({ childRunId: "child", parentSeq: 1 })
    ])
    expect(result.archive.orphaned).toEqual([edge])
    expect(runs.state("child").status).toBe("completed")
  })

  it("blocks a live detached child before any compensation runs", async () => {
    let reverts = 0
    const handler: EffectHandlerRegistry.Handler = {
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "message remains sent",
      revert: () =>
        Effect.sync(() => {
          reverts += 1
          return "receipt"
        }),
      rollback: () => Effect.void
    }
    const edge: LineageEdge = {
      parentRunId: "run",
      parentSeq: 1,
      childRunId: "child",
      kind: "child",
      attached: false
    }
    const store = MemoryTimeTravelStore.make({
      records: [baseline(), boundaryRecord(1, effect("send", "send", "irreversible"))],
      edges: [edge]
    })
    const runs = makeRuns([row("run"), row("child", "running")])
    const jj = makeJj("current")

    const failure = await Effect.runPromise(
      Effect.flip(
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-live" }),
          { store, runs, jj: jj.service, handlers: [handler] }
        )
      )
    )

    expect(failure.code).toBe("live_child")
    expect(reverts).toBe(0)
    expect(store.state().records).toHaveLength(2)
    expect(runs.state("run").status).toBe("suspended")
  })

  it("claims and cancels a nonterminal detached child under explicit cancel policy", async () => {
    const edge: LineageEdge = {
      parentRunId: "run",
      parentSeq: 1,
      childRunId: "child",
      kind: "child",
      attached: false
    }
    const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
    const runs = makeRuns([row("run"), row("child", "suspended")])
    const jj = makeJj("current")

    const result = await Effect.runPromise(
      provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit-cancel",
          detachedChildPolicy: "cancel"
        }),
        { store, runs, jj: jj.service }
      )
    )

    expect(result.cancelledChildren).toEqual(["child"])
    expect(runs.state("child")).toMatchObject({ status: "cancelled", owner: null })
  })

  it("resolves the full suffix before running any handler", async () => {
    let reverts = 0
    const handler: EffectHandlerRegistry.Handler = {
      kind: "known",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "known residue",
      revert: () =>
        Effect.sync(() => {
          reverts += 1
          return "receipt"
        }),
      rollback: () => Effect.void
    }
    const store = MemoryTimeTravelStore.make({
      records: [
        baseline(),
        boundaryRecord(1, effect("known", "known", "irreversible")),
        boundaryRecord(2, effect("missing", "missing", "irreversible"))
      ]
    })
    const runs = makeRuns([row("run")])
    const jj = makeJj("current")

    const failure = await Effect.runPromise(
      Effect.flip(
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-blocked" }),
          { store, runs, jj: jj.service, handlers: [handler] }
        )
      )
    )

    expect(failure.code).toBe("irreversible")
    expect(reverts).toBe(0)
    expect(store.state().records.map((record) => record.seq)).toEqual([0, 1, 2])
    expect(store.state().receipts).toEqual([])
    expect(runs.state("run").status).toBe("suspended")
  })
})
