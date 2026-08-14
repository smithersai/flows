/**
 * A fork assesses the boundary it carries past and restores the frame's tree.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork: the assessment runs but is
 * normalized to warnings — the fork never reverts a parent effect — and the
 * child gets its own worktree restored from the frame's jj pointer. These cases
 * pin the disclosure wording, the paging of a long suffix, and what a fork says
 * when the frame has no pointer to restore.
 */
import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as Jj from "@smthrs/jj-next"
import * as Journal from "@smthrs/journal-next/Journal"
import type * as JournalEvent from "@smthrs/journal-next/JournalEvent"
import * as SqlJournal from "@smthrs/journal-next/SqlJournal"
import * as RunStore from "@smthrs/run-store-next/RunStore"
import * as CacheStore from "@smthrs/step-cache-next/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const frame = { lineageId: "parent/root", seq: 0 } as const

const row = (): RunStore.RunRow => ({
  runId: "parent",
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

const boundaryEntry = (seq: number, id: string, kind: string): JournalEvent.Entry =>
  ({
    runId: "parent",
    seq,
    eventId: `e${seq}`,
    sourceId: "test",
    sourceSeq: seq,
    emittedAtMs: 0,
    eventType: EffectBoundary.eventType,
    payload: {
      effect: {
        id,
        kind,
        tier: "irreversible",
        status: "succeeded",
        runId: "parent",
        lineageId: frame.lineageId,
        residue: `${id} stands.`
      }
    },
    meta: { lineageId: frame.lineageId }
  }) as unknown as JournalEvent.Entry

const noise = (seq: number): JournalEvent.Entry =>
  ({
    runId: "parent",
    seq,
    eventId: `e${seq}`,
    sourceId: "test",
    sourceSeq: seq,
    emittedAtMs: 0,
    eventType: "flows.engine.attempt-finished",
    payload: {},
    meta: { lineageId: frame.lineageId }
  }) as unknown as JournalEvent.Entry

/** Pages the suffix one entry at a time, so the read loop actually loops. */
const journalOf = (entries: ReadonlyArray<JournalEvent.Entry>, pageSize: number) =>
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({
      entries: (options) => {
        const after = options.after
        const remaining = entries.filter((entry) => after === undefined || entry.seq > after)
        const page = remaining.slice(0, pageSize)
        return Effect.succeed({ entries: page, hasMore: remaining.length > page.length })
      }
    })
  )

const runFork = (options: {
  readonly entries: ReadonlyArray<JournalEvent.Entry>
  readonly snapshots?: ReadonlyArray<{ readonly changeId: string }>
  readonly restore?: (changeId: string) => Effect.Effect<void, never>
  readonly journal?: Layer.Layer<Journal.Journal>
  readonly handlers?: ReadonlyArray<EffectHandlerRegistry.Handler>
}) => {
  const calls: Array<string> = []
  const store = MemoryTimeTravelStore.make({
    snapshots: (options.snapshots ?? []).map((snapshot) => ({
      runId: "parent",
      frame,
      changeId: snapshot.changeId
    }))
  })
  return Effect.runPromise(
    Effect.scoped(
      Fork.fork({
        parentRunId: "parent",
        frame,
        workspaceName: "fork-workspace",
        workspacePath: "/tmp/fork-workspace",
        pageSize: 1
      }).pipe(
        Effect.map((result) => ({ result, calls })),
        Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
        Effect.provide(Layer.succeed(TimeTravelStore, store)),
        Effect.provide(
          Layer.succeed(
            Jj.Jj,
            Jj.makeNoop({
              workspaceAdd: (name) => Effect.sync(() => void calls.push(`add:${name}`)),
              workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`)),
              restore: (changeId) =>
                options.restore === undefined
                  ? Effect.sync(() => void calls.push(`restore:${changeId}`))
                  : options.restore(changeId)
            })
          )
        ),
        Effect.provide(options.journal ?? journalOf(options.entries, 1)),
        Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop({ get: () => Effect.succeedNone }))),
        Effect.provide(EffectHandlerRegistry.layer(options.handlers ?? []))
      )
    ) as unknown as Effect.Effect<
      { readonly result: { readonly warnings: ReadonlyArray<string> }; readonly calls: Array<string> }
    >
  )
}

describe("fork boundary assessment", () => {
  it("normalizes every crossed effect to a warning and never touches the parent's tree", async () => {
    const handler: EffectHandlerRegistry.Handler = {
      kind: "billing/Charge",
      tier: "irreversible",
      requiresIdempotencyKey: false,
      residue: () => "The charge stands.",
      revert: () => Effect.succeed({}),
      rollback: () => Effect.void
    }
    const { calls, result } = await runFork({
      // Two pages of suffix, one revertible (a handler resolves) and one
      // blocking (none does). A fork reverts neither.
      entries: [
        boundaryEntry(1, "charge-1", "billing/Charge"),
        noise(2),
        boundaryEntry(3, "email-1", "mail/Send")
      ],
      snapshots: [{ changeId: "change-at-frame" }],
      handlers: [handler]
    })

    expect(result.warnings).toEqual([
      "billing/Charge (charge-1) was classified revertible for rewind; on a fork it is never reverted and may " +
      "execute again on the child. The charge stands.",
      "mail/Send (email-1) was classified blocking for rewind; on a fork it is never reverted and may " +
      "execute again on the child. email-1 stands.",
      "Fork workspace fork-workspace was created at the lane default, not at the frame's jj pointer " +
      "change-at-frame: provisioning a workspace at a revision is not yet expressible through Jj. " +
      "Restore it before running work that assumes the frame's tree."
    ])
    // `Jj.restore` acts on the ONE working copy the layer is rooted at — the
    // parent's. `docs/specs/Concepts/Time Travel.md` §Fork forbids a fork from
    // restoring it, so the fork discloses the pointer instead of applying it.
    expect(calls).toEqual(["add:fork-workspace", "forget:fork-workspace"])
  })

  it("keeps a `warning` classification's own disclosure verbatim", async () => {
    const { result } = await runFork({
      entries: [boundaryEntry(1, "charge-1", "billing/Charge")],
      snapshots: [{ changeId: "change-at-frame" }],
      handlers: [{
        kind: "billing/Charge",
        tier: "irreversible",
        requiresIdempotencyKey: false,
        residue: () => "unused",
        assess: () =>
          Effect.succeed({
            classification: "warning" as const,
            reason: "policy allows it",
            residue: "The charge stands and will not be refunded."
          }),
        revert: () => Effect.succeed({}),
        rollback: () => Effect.void
      }]
    })

    expect(result.warnings).toEqual([
      "billing/Charge (charge-1): The charge stands and will not be refunded.",
      "Fork workspace fork-workspace was created at the lane default, not at the frame's jj pointer " +
      "change-at-frame: provisioning a workspace at a revision is not yet expressible through Jj. " +
      "Restore it before running work that assumes the frame's tree."
    ])
  })

  it("says so, rather than restoring a wrong tree, when the frame has no pointer", async () => {
    const { calls, result } = await runFork({ entries: [noise(1)] })

    expect(result.warnings).toEqual([
      "Frame parent/root@0 has no recorded jj pointer; the fork workspace fork-workspace starts from the lane " +
      "default rather than the frame."
    ])
    expect(calls).toEqual(["add:fork-workspace", "forget:fork-workspace"])
  })

  it("maps a suffix read failure and a workspace-add failure to typed errors", async () => {
    const readFailure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Fork.fork({
            parentRunId: "parent",
            frame,
            workspaceName: "fork-workspace",
            workspacePath: "/tmp/fork-workspace"
          }).pipe(
            Effect.provide(
              Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
            ),
            Effect.provide(Layer.succeed(TimeTravelStore, MemoryTimeTravelStore.make())),
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
            Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop())),
            Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
            Effect.provide(EffectHandlerRegistry.layerNoop)
          )
        )
      ) as unknown as Effect.Effect<{ readonly message: string }>
    )
    const workspaceFailure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Fork.fork({
            parentRunId: "parent",
            frame,
            workspaceName: "fork-workspace",
            workspacePath: "/tmp/fork-workspace"
          }).pipe(
            Effect.provide(
              Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
            ),
            Effect.provide(
              Layer.succeed(
                TimeTravelStore,
                MemoryTimeTravelStore.make({
                  snapshots: [{ runId: "parent", frame, changeId: "change-at-frame" }]
                })
              )
            ),
            // `workspaceAdd` is left unimplemented, so the noop's
            // `not_installed` failure is what has to arrive typed.
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({ workspaceForget: () => Effect.void }))),
            Effect.provide(journalOf([], 1)),
            Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
            Effect.provide(EffectHandlerRegistry.layerNoop)
          )
        )
      ) as unknown as Effect.Effect<{ readonly message: string }>
    )

    expect(readFailure.message).toBe("could not read fork suffix for parent")
    expect(workspaceFailure.message).toBe("could not add fork workspace")
  })

  // BUG: createFork commits before workspaceAdd, so a failed workspace leaves a durable orphan child and edge.
  it.fails("leaves no child run, lineage edge, or copied records when workspace creation fails", async () => {
    const store = MemoryTimeTravelStore.make({
      records: [{ runId: "parent", seq: 0, eventId: "parent-0", lineageId: frame.lineageId, payload: {} }]
    })
    const before = store.state()

    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Fork.fork({
            parentRunId: "parent",
            frame,
            workspaceName: "fork-workspace",
            workspacePath: "/tmp/fork-workspace"
          }).pipe(
            Effect.provide(
              Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))
            ),
            Effect.provide(Layer.succeed(TimeTravelStore, store)),
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({ workspaceForget: () => Effect.void }))),
            Effect.provide(journalOf([], 1)),
            Effect.provide(Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())),
            Effect.provide(EffectHandlerRegistry.layerNoop)
          )
        )
      )
    )

    expect(failure).toMatchObject({ code: "unknown", message: "could not add fork workspace" })
    expect(store.state().edges).toEqual(before.edges)
    expect(store.state().records).toEqual(before.records)
  })

  // BUG: the SQL createFork transaction commits the child, edge, copied journal prefix, and copied attempt before
  // workspaceAdd runs; the typed workspace failure has no compensating transaction to remove that durable orphan.
  it.fails("rolls back every SQL fork row when workspace creation fails", async () => {
    const migrated = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
    const services = Layer.mergeAll(
      RunStore.layer,
      SqlJournal.layer({ capacity: 32, overflow: "reject" }),
      CacheStore.layer,
      SqlTimeTravelStore.layer
    ).pipe(Layer.provideMerge(migrated))

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('parent', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "ForkParent", payload: {} })})
          `
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('parent', 0, 'parent-attempt', 'fork-boundary', 0, 0,
                    'flows.engine.attempt-started',
                    ${JSON.stringify({ stepKeyDigest: "parent-step", attempt: 1 })},
                    ${JSON.stringify({ lineageId: frame.lineageId })})
          `
          yield* sql`
            INSERT INTO flows_attempts
              (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
            VALUES ('parent', 'parent-step', 1, 'succeeded', 0, '{}')
          `
          const failure = yield* Effect.flip(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceName: "fork-workspace",
              workspacePath: "/tmp/fork-workspace"
            }).pipe(
              Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({ workspaceForget: () => Effect.void }))),
              Effect.provide(EffectHandlerRegistry.layerNoop)
            )
          )
          const children = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_runs WHERE run_id <> 'parent'
          `
          const edges = yield* sql<{ readonly child_run_id: string }>`
            SELECT child_run_id FROM flows_time_travel_edges
          `
          const copiedJournal = yield* sql<{ readonly run_id: string; readonly seq: number }>`
            SELECT run_id, seq FROM flows_journal_events WHERE run_id <> 'parent'
          `
          const copiedAttempts = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_attempts WHERE run_id <> 'parent'
          `
          const copiedSnapshots = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_time_travel_snapshots WHERE run_id <> 'parent'
          `
          return { children, copiedAttempts, copiedJournal, copiedSnapshots, edges, failure }
        }).pipe(Effect.provide(services))
      )
    )

    expect(result.failure).toMatchObject({ code: "unknown", message: "could not add fork workspace" })
    expect(result.children).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.copiedJournal).toEqual([])
    expect(result.copiedAttempts).toEqual([])
    expect(result.copiedSnapshots).toEqual([])
  })
})

describe("the compensation descriptor on a boundary record", () => {
  it("survives the round trip a rewind's handler preflight reads it through", async () => {
    const emitted: Array<JournalEvent.Input> = []
    await Effect.runPromise(
      EffectBoundary.guard({
        id: "charge-1",
        kind: "billing/Charge",
        tier: "irreversible",
        runId: "parent",
        lineageId: frame.lineageId,
        sourceId: "test",
        compensation: "billing/refund@v2",
        residue: "The charge stands."
      }, Effect.succeed("ok")).pipe(
        Effect.provide(
          Layer.succeed(
            Journal.Journal,
            Journal.makeNoop({
              emitDurable: (input) =>
                Effect.sync(() => {
                  emitted.push(input)
                  return { _tag: "Accepted", seq: emitted.length, sourceSeq: 0 } as never
                })
            })
          )
        )
      )
    )
    const decoded = EffectBoundary.fromEntry({
      ...emitted[1],
      seq: 1
    } as unknown as JournalEvent.Entry)

    expect(decoded?.compensation).toBe("billing/refund@v2")
    expect(decoded?.status).toBe("succeeded")
  })
})
