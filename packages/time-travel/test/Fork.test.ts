import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Memory from "../src/MemoryTimeTravelStore.ts"

describe("fork", () => {
  it("creates unique immutable prefix copies", async () => {
    const store = Memory.make({
      records: [
        { runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null },
        { runId: "r", seq: 2, eventId: "b", lineageId: "r", payload: null }
      ]
    })
    const before = store.state().records
    const first = await Effect.runPromise(store.createFork("r", { lineageId: "r", seq: 0 }))
    const second = await Effect.runPromise(store.createFork("r", { lineageId: "r", seq: 0 }))

    expect(first.runId).not.toBe(second.runId)
    expect(store.state().records.filter((record) => record.runId === first.runId)).toHaveLength(1)
    expect(store.state().records.filter((record) => record.runId === second.runId)).toHaveLength(1)
    expect(store.state().records.filter((record) => record.runId === "r")).toEqual(before)
  })

  it("refuses a fork when any ancestor is live", async () => {
    const store = Memory.make({
      records: [{ runId: "child", seq: 0, eventId: "child-0", lineageId: "child", payload: null }],
      edges: [
        { parentRunId: "root", parentSeq: 0, childRunId: "middle", kind: "child", attached: true },
        { parentRunId: "middle", parentSeq: 0, childRunId: "child", kind: "child", attached: true }
      ],
      liveRuns: new Set(["root"])
    })

    const failure = await Effect.runPromise(
      Effect.flip(store.createFork("child", { lineageId: "child", seq: 0 }))
    )
    expect(failure.code).toBe("live_parent")
  })
})
