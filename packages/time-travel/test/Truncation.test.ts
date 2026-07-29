import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { LineageEdge } from "../src/Frame.ts"
import * as Memory from "../src/MemoryTimeTravelStore.ts"

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
})
