/**
 * The derived half of a frame: anchors, state, and attempts.
 *
 * `docs/specs/Concepts/Time Travel.md` makes frame state DERIVED — the only
 * things stored per frame are the jj pointer and the plan digest, and both
 * arrive through a projection of the engine's own records rather than an engine
 * write. These cases pin the fold, its carried-pointer resolution, and the
 * store contract both implementations answer.
 */
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as SnapshotProjector from "../src/internal/SnapshotProjector.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const lineageId = "run/root"

interface Fixture {
  readonly seq: number
  readonly eventType: string
  readonly payload: unknown
  readonly lineageId?: string | undefined
}

/** A journal double that pages exactly like the SQL one, with no live tail. */
const pagingJournal = (fixtures: ReadonlyArray<Fixture>, pageSize: number) =>
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({
      entries: (options) => {
        const after = options.after
        const remaining = fixtures.filter((fixture) => after === undefined || fixture.seq > after)
        const page = remaining.slice(0, Math.min(options.limit, pageSize))
        return Effect.succeed({
          entries: page.map((fixture) => ({
            runId: "run" as JournalEvent.RunId,
            seq: fixture.seq as JournalEvent.Seq,
            eventId: `e${fixture.seq}`,
            sourceId: "test" as JournalEvent.SourceId,
            sourceSeq: fixture.seq as JournalEvent.SourceSeq,
            emittedAtMs: 0,
            eventType: fixture.eventType,
            payload: fixture.payload,
            meta: "lineageId" in fixture && fixture.lineageId === undefined
              ? {}
              : { lineageId: fixture.lineageId ?? lineageId }
          })) as unknown as ReadonlyArray<JournalEvent.Entry>,
          hasMore: remaining.length > page.length
        })
      }
    })
  )

const projectInto = (
  fixtures: ReadonlyArray<Fixture>,
  options: { readonly pageSize?: number } = {}
) => {
  const store = MemoryTimeTravelStore.make()
  return Effect.runPromise(
    SnapshotProjector.project("run", 2).pipe(
      Effect.provide(pagingJournal(fixtures, options.pageSize ?? 2)),
      Effect.provideService(TimeTravelStore.TimeTravelStore, store),
      Effect.map((state) => ({ state, snapshots: store.state().snapshots }))
    ) as Effect.Effect<
      { readonly state: SnapshotProjector.State; readonly snapshots: ReadonlyArray<TimeTravelStore.Snapshot> },
      unknown
    >
  )
}

describe("the snapshot projector", () => {
  it("resolves a carried anchor to the last real pointer, and stamps the plan digest in force", async () => {
    const result = await projectInto([
      // No pointer yet: a carried anchor before any snapshot has nothing to
      // carry, and inventing one would be worse than recording none.
      { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
      { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
      { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } },
      { seq: 3, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
      { seq: 4, eventType: "flows.engine.subgraph-appended", payload: { digest: "plan-b" } },
      { seq: 5, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
      // Records the fold has no business in.
      { seq: 6, eventType: "flows.engine.attempt-finished", payload: {} }
    ])

    expect(result.state).toEqual({ changeId: "change-1", planDigest: "plan-b", anchors: 3 })
    expect(result.snapshots).toEqual([
      { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-1", planDigest: "plan-a" },
      { runId: "run", frame: { lineageId, seq: 3 }, changeId: "change-1", planDigest: "plan-a" },
      { runId: "run", frame: { lineageId, seq: 5 }, changeId: "change-1", planDigest: "plan-b" }
    ])
  })

  it("skips what it cannot address or decode", async () => {
    const result = await projectInto([
      // No lineage: an anchor with no frame address is not an anchor.
      { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "x" }, lineageId: undefined },
      // Undecodable payloads on both channels.
      { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: 42 } },
      { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: 7 } }
    ])

    expect(result.state).toEqual({ changeId: undefined, planDigest: undefined, anchors: 0 })
    expect(result.snapshots).toEqual([])
  })

  it("is idempotent: the same journal folded twice leaves one anchor per frame", async () => {
    const store = MemoryTimeTravelStore.make()
    const fixtures: ReadonlyArray<Fixture> = [
      { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } }
    ]
    await Effect.runPromise(
      SnapshotProjector.project("run").pipe(
        Effect.andThen(SnapshotProjector.project("run")),
        Effect.provide(pagingJournal(fixtures, 10)),
        Effect.provideService(TimeTravelStore.TimeTravelStore, store)
      ) as Effect.Effect<unknown, unknown>
    )

    expect(store.state().snapshots).toHaveLength(1)
  })
})

describe("the memory store's derived reads", () => {
  const store = MemoryTimeTravelStore.make({
    records: [
      {
        runId: "run",
        seq: 0,
        eventId: "e0",
        lineageId,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "created",
          state: { version: 1, flowName: "Demo", payload: { seed: 1 } }
        }
      },
      {
        runId: "run",
        seq: 1,
        eventId: "e1",
        lineageId,
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "a",
          attempt: 1
        }
      },
      // A decision that carries no state leaves the fold where it was.
      {
        runId: "run",
        seq: 2,
        eventId: "e2",
        lineageId,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "claim-lost"
        }
      },
      // Not an attempt record shape, and a record of another lineage.
      { runId: "run", seq: 3, eventId: "e3", lineageId, eventType: "flows.engine.attempt-started", payload: {} },
      {
        runId: "run",
        seq: 4,
        eventId: "e4",
        lineageId: "run/other",
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "b",
          attempt: 1
        }
      },
      {
        runId: "run",
        seq: 5,
        eventId: "e5",
        lineageId,
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "b",
          attempt: 1
        }
      }
    ]
  })

  it("rebuilds state at a frame from the decisions up to it", async () => {
    expect(await Effect.runPromise(store.stateAt("run", { lineageId, seq: 4 }))).toBe(
      JSON.stringify({ version: 1, flowName: "Demo", payload: { seed: 1 } })
    )
    // Before the `created` decision there is nothing to rebuild.
    expect(await Effect.runPromise(store.stateAt("run", { lineageId, seq: 0 }))).toBeDefined()
    expect(await Effect.runPromise(store.stateAt("other", { lineageId, seq: 9 }))).toBeUndefined()
  })

  it("collects the attempts admitted at a frame, deduplicated and lineage-filtered", async () => {
    expect(await Effect.runPromise(store.attemptsAt("run", { lineageId, seq: 4 }))).toEqual([
      { stepKeyDigest: "a", attempt: 1 }
    ])
    expect(await Effect.runPromise(store.attemptsAt("run", { lineageId, seq: 5 }))).toEqual([
      { stepKeyDigest: "a", attempt: 1 },
      { stepKeyDigest: "b", attempt: 1 }
    ])
  })

  it("upserts an anchor and rolls the write back on an injected failure", async () => {
    const writable = MemoryTimeTravelStore.make()
    const anchor: TimeTravelStore.Snapshot = { runId: "run", frame: { lineageId, seq: 1 }, changeId: "c1" }
    await Effect.runPromise(writable.recordSnapshot(anchor))
    await Effect.runPromise(writable.recordSnapshot({ ...anchor, changeId: "c2" }))
    expect(writable.state().snapshots).toEqual([{ ...anchor, changeId: "c2" }])

    const failing = MemoryTimeTravelStore.make({ failAt: "recordSnapshot" })
    const failure = await Effect.runPromise(Effect.flip(failing.recordSnapshot(anchor)))
    expect(failure).toMatchObject({ code: "unknown" })
    expect(failing.state().snapshots).toEqual([])
  })
})

describe("the store facade", () => {
  it("reports every derived read as unavailable until an implementation supplies it", async () => {
    const noop = TimeTravelStore.makeNoop()
    const failures = await Effect.runPromise(
      Effect.all([
        Effect.flip(noop.recordSnapshot({ runId: "run", frame: { lineageId, seq: 0 }, changeId: "c" })),
        Effect.flip(noop.stateAt("run", { lineageId, seq: 0 })),
        Effect.flip(noop.attemptsAt("run", { lineageId, seq: 0 }))
      ])
    )
    expect(failures.map((failure) => failure.message)).toEqual([
      "recordSnapshot is unavailable",
      "stateAt is unavailable",
      "attemptsAt is unavailable"
    ])
  })
})

describe("the projector's read failures", () => {
  it("surfaces a journal it cannot page as a typed failure", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(SnapshotProjector.project("run")).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop())),
        Effect.provideService(TimeTravelStore.TimeTravelStore, MemoryTimeTravelStore.make())
      ) as unknown as Effect.Effect<{ readonly code: string; readonly message: string }, never>
    )

    expect(failure).toMatchObject({ code: "unknown", message: "could not read run for anchoring" })
  })
})
