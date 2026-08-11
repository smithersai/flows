/**
 * Service-level cover for the one public time-travel door.
 *
 * The module suites next door drive `Replay`, `Fork`, `Rewind`, and `Recovery`
 * directly; this one only asserts what the service adds — that the three verbs
 * are reachable with nothing but a `Position`, that the fork workspace and the
 * rewind ownership claim are derived internally, and that an interrupted
 * rewind is resolved while the layer is being built rather than by a call the
 * user has to remember to make.
 */
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import type { Audit } from "../src/TimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const lineageId = "run/root"

const record = (seq: number, amount: number): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId,
  payload: {
    eventType: "test.credited",
    payload: { amount },
    meta: { lineageId }
  }
})

const row = (runId: string): RunStore.RunRow => ({
  runId,
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
})

const makeRuns = (): RunStore.Service => {
  const state = new Map([["run", { ...row("run") }]])
  return RunStore.makeNoop({
    get: (runId) => {
      const found = state.get(runId)
      return found === undefined
        ? Effect.fail(
          new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: runId })
        )
        : Effect.succeed({ ...found })
    },
    claim: (runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        found.claim = claimant
        found.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        found.status = "running"
        found.owner = claimant
        found.heartbeatAtMs = claimedAtMs
        found.claim = null
        found.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    transitionOwned: (runId, currentOwner, status) =>
      Effect.sync(() => {
        const found = state.get(runId)!
        if (found.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        found.status = status
        found.owner = null
        found.heartbeatAtMs = null
        return { _tag: "Transitioned" as const }
      })
  })
}

const makeJournal = (store: ReturnType<typeof MemoryTimeTravelStore.make>): Journal.Service =>
  Journal.makeNoop({
    entries: ({ after, limit, runId }) =>
      Effect.sync(() => {
        const all = store.state().records
          .filter((entry) => entry.runId === runId && entry.seq > (after ?? -1))
          .sort((left, right) => left.seq - right.seq)
        const selected = all.slice(0, limit)
        return {
          entries: selected.map((entry) => {
            const stored = entry.payload as {
              readonly eventType: string
              readonly payload: unknown
              readonly meta: unknown
            }
            return {
              runId: entry.runId as JournalEvent.RunId,
              seq: entry.seq as JournalEvent.Seq,
              eventId: entry.eventId,
              sourceId: "test" as JournalEvent.SourceId,
              sourceSeq: entry.seq as JournalEvent.SourceSeq,
              emittedAtMs: entry.seq,
              eventType: stored.eventType,
              payload: stored.payload,
              meta: stored.meta
            } as JournalEvent.Entry
          }),
          hasMore: all.length > selected.length
        }
      })
  })

const harness = (options: {
  readonly store: ReturnType<typeof MemoryTimeTravelStore.make>
  readonly workspaces?: Array<string>
}) =>
  TimeTravel.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TimeTravelStore)(options.store),
        Layer.succeed(RunStore.RunStore)(makeRuns()),
        Layer.succeed(Journal.Journal)(makeJournal(options.store)),
        Layer.succeed(Jj.Jj)(
          Jj.makeNoop({
            snapshot: () => Effect.succeed({ changeId: "current" }),
            workspaceAdd: (name, path) =>
              Effect.sync(() => {
                options.workspaces?.push(`${name}@${path}`)
              }),
            workspaceForget: () => Effect.void
          })
        ),
        CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
      )
    )
  )

const run = <A>(
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  body: (timeTravel: TimeTravel["Service"]) => Effect.Effect<A, unknown>,
  workspaces?: Array<string>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const timeTravel = yield* TimeTravel
        return yield* body(timeTravel)
      }).pipe(
        Effect.provide(harness({ store, ...(workspaces === undefined ? {} : { workspaces }) })),
        Effect.orDie
      )
    )
  )

describe("TimeTravel", () => {
  it("inspects a position by folding committed evidence up to the frame", async () => {
    const store = MemoryTimeTravelStore.make({
      records: [record(0, 10), record(1, 20), record(2, 30)]
    })

    const total = await run(store, (timeTravel) =>
      timeTravel.inspect(
        { runId: "run", frame: { lineageId, seq: 1 } },
        {
          initial: 0,
          reduce: (state: number, entry) => {
            const payload = entry.payload as { readonly amount?: number } | null
            return state + (payload?.amount ?? 0)
          }
        }
      ))

    expect(total).toBe(30)
  })

  it("forks at a position and derives the workspace name and path itself", async () => {
    const store = MemoryTimeTravelStore.make({ records: [record(0, 10), record(1, 20)] })
    const workspaces: Array<string> = []

    const fork = await run(
      store,
      (timeTravel) => timeTravel.fork({ runId: "run", frame: { lineageId, seq: 1 } }),
      workspaces
    )

    expect(fork.edge).toMatchObject({ parentRunId: "run", parentSeq: 1, kind: "fork" })
    expect(fork.runId).toBe("run:fork:1")
    // Derived, never caller-supplied: the position names the lane.
    expect(workspaces).toEqual(["flows-fork-run-1@.flows/forks/flows-fork-run-1"])
  })

  it("rewinds at a position with the ownership claim wired internally", async () => {
    const store = MemoryTimeTravelStore.make({
      records: [record(0, 10), record(1, 20), record(2, 30), record(3, 40)]
    })

    const result = await run(store, (timeTravel) => timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 1 } }))

    expect(result.archive.archived).toBe(2)
    expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1])
    expect(store.state().audits.map((audit) => audit.status)).toEqual(["completed"])
  })

  it("honours the only two knobs it takes: fork root and rewind paging", async () => {
    const store = MemoryTimeTravelStore.make({
      records: [record(0, 10), record(1, 20), record(2, 30), record(3, 40)]
    })
    const workspaces: Array<string> = []

    const result = await run(
      store,
      (timeTravel) =>
        Effect.gen(function*() {
          yield* timeTravel.fork({ runId: "run", frame: { lineageId, seq: 1 } }, {
            workspaceRoot: "/tmp/lanes"
          })
          return yield* timeTravel.rewind({ runId: "run", frame: { lineageId, seq: 1 } }, {
            detachedChildren: "cancel",
            pageSize: 1
          })
        }),
      workspaces
    )

    expect(workspaces).toEqual(["flows-fork-run-1@/tmp/lanes/flows-fork-run-1"])
    expect(result.archive.archived).toBe(2)
  })

  it("resolves an interrupted rewind while the layer is built", async () => {
    const store = MemoryTimeTravelStore.make({
      records: [record(0, 10), record(1, 20), record(2, 30)]
    })
    const interrupted: Audit = {
      id: "run:interrupted",
      runId: "run",
      frame: { lineageId, seq: 1 },
      status: "in_progress",
      detail: {
        version: 1,
        phase: "preflight_complete",
        originalStatus: "suspended",
        suffixCount: 1,
        warnings: [],
        cancelledChildren: []
      }
    }
    await Effect.runPromise(store.writeAudit(interrupted).pipe(Effect.orDie))

    // No user call: merely acquiring the service resolves the audit.
    const audits = await run(store, () => Effect.succeed(store.state().audits))

    expect(audits.map((audit) => audit.status)).toEqual(["failed"])
    expect(audits[0]?.detail).toMatchObject({ phase: "rolled_back" })
    // The suffix the interrupted rewind never committed is still there.
    expect(store.state().records.map((entry) => entry.seq)).toEqual([0, 1, 2])
  })
})
