import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { LineageEdge } from "../src/Frame.ts"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const records: ReadonlyArray<Memory.JournalRecord> = [
  { runId: "parent", seq: 0, eventId: "parent-0", lineageId: "parent/root", payload: null },
  { runId: "parent", seq: 2, eventId: "parent-2", lineageId: "parent/root", payload: null },
  { runId: "child", seq: 0, eventId: "child-0", lineageId: "child/root", payload: null },
  { runId: "grandchild", seq: 0, eventId: "grandchild-0", lineageId: "grandchild/root", payload: null },
  { runId: "detached", seq: 0, eventId: "detached-0", lineageId: "detached/root", payload: null }
]

const edges: ReadonlyArray<LineageEdge> = [
  { parentRunId: "parent", parentSeq: 2, childRunId: "child", kind: "child", attached: true },
  { parentRunId: "child", parentSeq: 0, childRunId: "grandchild", kind: "continuation", attached: true },
  { parentRunId: "parent", parentSeq: 2, childRunId: "detached", kind: "child", attached: false }
]

describe("truncation", () => {
  it("projects the nearest snapshot, deduplicates cyclic attached descendants, and preserves detached edges", async () => {
    const cyclic: ReadonlyArray<LineageEdge> = [
      { parentRunId: "parent", parentSeq: 1, childRunId: "child", kind: "child", attached: true },
      { parentRunId: "parent", parentSeq: 2, childRunId: "child", kind: "continuation", attached: true },
      { parentRunId: "child", parentSeq: 0, childRunId: "parent", kind: "continuation", attached: true },
      { parentRunId: "parent", parentSeq: 2, childRunId: "detached", kind: "child", attached: false },
      { parentRunId: "parent", parentSeq: 3, childRunId: "detached", kind: "fork", attached: false }
    ]
    const store = Memory.make({
      edges: cyclic,
      snapshots: [
        { runId: "parent", frame: { lineageId: "parent/root", seq: 0 }, changeId: "old" },
        { runId: "parent", frame: { lineageId: "parent/root", seq: 2 }, changeId: "near" }
      ]
    })
    expect(await Effect.runPromise(store.snapshotAt("parent", { lineageId: "parent/root", seq: 1 })))
      .toMatchObject({ changeId: "old" })
    expect(await Effect.runPromise(store.snapshotAt("parent", { lineageId: "parent/root", seq: 2 })))
      .toMatchObject({ changeId: "near" })
    expect(await Effect.runPromise(store.snapshotAt("parent", { lineageId: "other", seq: 5 }))).toBeUndefined()
    expect(await Effect.runPromise(store.descendants("parent", { lineageId: "parent/root", seq: 0 })))
      .toEqual({ attached: [cyclic[0], cyclic[2]], detached: [cyclic[3]] })
  })

  it("makes audit, receipt, fork, and layer operations transactional", async () => {
    const store = Memory.make({ records, liveRuns: new Set(["ancestor"]) })
    await Effect.runPromise(
      store.writeAudit({
        id: "audit",
        runId: "parent",
        frame: { lineageId: "parent/root", seq: 0 },
        status: "in_progress"
      })
    )
    await Effect.runPromise(store.updateAudit("audit", { status: "completed", detail: { finished: true } }))
    await Effect.runPromise(
      store.recordReceipt({ id: "receipt", auditId: "audit", effectId: "effect", receipt: { undo: true } })
    )
    expect(await Effect.runPromise(store.pendingAudits())).toEqual([])
    expect(store.state()).toMatchObject({ receipts: [{ id: "receipt" }], audits: [{ status: "completed" }] })
    const fork = await Effect.runPromise(store.createFork("parent", { lineageId: "parent/root", seq: 0 }))
    expect(store.state().records.filter((record) => record.runId === fork.runId)).toEqual([
      expect.objectContaining({ eventId: `fork:${fork.runId}:0` })
    ])
    const failed = Memory.make({ records, failAt: "recordReceipt" })
    await Effect.runPromise(Effect.flip(failed.recordReceipt({ id: "r", auditId: "a", effectId: "e", receipt: null })))
    expect(failed.state().receipts).toEqual([])
    const layered = await Effect.runPromise(
      Effect.gen(function*() {
        const timeTravel = yield* TimeTravelStore
        return yield* timeTravel.pendingAudits()
      }).pipe(Effect.provide(Memory.layer()))
    )
    expect(layered).toEqual([])
  })
  it("archives the parent suffix and every attached descendant atomically", async () => {
    const store = Memory.make({ records, edges })
    const result = await Effect.runPromise(
      store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [])
    )

    expect(result.archived).toBe(3)
    expect(result.orphaned.map((edge) => edge.childRunId)).toEqual(["detached"])
    expect(store.state().records.map((record) => record.eventId)).toEqual(["parent-0", "detached-0"])
    expect(store.state().archived.map((record) => record.eventId)).toEqual([
      "parent-2",
      "child-0",
      "grandchild-0"
    ])
    expect(store.state().edges).toEqual([edges[2]])
  })

  it("rolls back every mutation when the transaction fails before truncation", async () => {
    const store = Memory.make({ records, edges, failAt: "archiveAndTruncate:before-truncate" })
    const before = store.state()

    await Effect.runPromise(
      Effect.flip(store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, []))
    )

    expect(store.state()).toEqual(before)
  })

  it("keeps every in-memory transaction atomic at each mutation boundary", async () => {
    const receipt = { id: "receipt", auditId: "audit", effectId: "effect", receipt: { reverted: true } }
    for (
      const failAt of [
        "archiveAndTruncate:start",
        "archiveAndTruncate:before-archive",
        "archiveAndTruncate:commit"
      ]
    ) {
      const store = Memory.make({ records, edges, failAt })
      const before = store.state()
      await Effect.runPromise(
        Effect.flip(store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [receipt]))
      )
      expect(store.state()).toEqual(before)
    }

    for (const failAt of ["createFork:start", "createFork:copy", "createFork:commit"]) {
      const store = Memory.make({ records, edges, failAt })
      const before = store.state()
      await Effect.runPromise(
        Effect.flip(store.createFork("parent", { lineageId: "parent/root", seq: 0 }))
      )
      expect(store.state()).toEqual(before)
    }
  })

  it("reports a missing audit without changing the stored audit history", async () => {
    const store = Memory.make()
    const failure = await Effect.runPromise(Effect.flip(store.updateAudit("missing", { status: "failed" })))

    expect(failure).toMatchObject({ code: "not_found", message: "audit missing was not found" })
    expect(store.state().audits).toEqual([])
  })

  it("normalizes unexpected in-memory transaction failures and restores state", async () => {
    const malformed = {
      runId: "parent",
      seq: 1,
      eventId: "malformed",
      lineageId: "parent/root",
      payload: null
    }
    Object.defineProperty(malformed, "runId", {
      get: () => {
        throw Object.assign(new Error("record read failed"), { code: "EIO" })
      }
    })
    const store = Memory.make({ records: [malformed] })
    const before = store.state()

    const failure = await Effect.runPromise(
      Effect.flip(store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, []))
    )

    expect(failure).toMatchObject({ code: "unknown", message: "memory transaction failed" })
    expect(store.state()).toEqual(before)
  })
})
