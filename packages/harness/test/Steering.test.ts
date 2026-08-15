/**
 * Pi §7 and OpenCode steering/queue parity:
 * `docs/specs/Research/Pi Reference Findings 2026-07-27.md`.
 * Coverage manifest: `docs/reference/test-parity.md`.
 */
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { describe, expect, it } from "vitest"
import * as Steering from "../src/Steering.ts"

describe("Steering", () => {
  it("keeps an item admitted after the close cutoff for the next turn", () => {
    const before = Steering.enqueue(Steering.empty(), {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: 1,
      message: ModelRequest.Message.user("before")
    })
    const queue = Steering.enqueue(before, {
      _tag: "Insert",
      delivery: "steer",
      admittedAt: 2,
      message: ModelRequest.Message.user("after")
    })
    const drained = Steering.drainAtClose(queue, 1)
    expect(drained.inserts).toEqual([ModelRequest.Message.user("before")])
    expect(drained.remaining.items).toHaveLength(1)
    expect(Steering.drainAtClose(drained.remaining, 2).inserts).toEqual([ModelRequest.Message.user("after")])
  })

  it("preserves FIFO insertion order at close", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("one")
      }),
      {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("two")
      }
    )
    expect(Steering.drainAtClose(queue, 1).inserts).toEqual([
      ModelRequest.Message.user("one"),
      ModelRequest.Message.user("two")
    ])
  })

  it("surfaces seat and thinking changes only in the next frame snapshot", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "SeatChange",
        delivery: "steer",
        admittedAt: 3,
        seat: "sdk:fast"
      }),
      { _tag: "ThinkingChange", delivery: "steer", admittedAt: 3, thinking: "high" }
    )
    expect(Steering.drainAtClose(queue, 2).seatChanges).toEqual([])
    expect(Steering.drainAtClose(queue, 3).seatChanges).toEqual([
      { _tag: "SeatChange", delivery: "steer", admittedAt: 3, seat: "sdk:fast" },
      { _tag: "ThinkingChange", delivery: "steer", admittedAt: 3, thinking: "high" }
    ])
  })

  it("only activates tools additively", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "ActivateTools",
        delivery: "steer",
        admittedAt: 1,
        toolNames: ["alpha", "beta"]
      }),
      { _tag: "ActivateTools", delivery: "steer", admittedAt: 1, toolNames: ["beta", "gamma"] }
    )
    expect(Steering.drainAtClose(queue, 1).activatedToolNames).toEqual(["alpha", "beta", "gamma"])
  })

  it("returns immutable serializable values", () => {
    const queue = Steering.enqueue(Steering.empty(), {
      _tag: "ActivateTools",
      delivery: "steer",
      admittedAt: 1,
      toolNames: ["alpha"]
    })
    expect(Object.isFrozen(queue)).toBe(true)
    expect(Object.isFrozen(queue.items)).toBe(true)
    expect(JSON.parse(JSON.stringify(queue))).toEqual({
      items: [{ _tag: "ActivateTools", delivery: "steer", admittedAt: 1, toolNames: ["alpha"] }]
    })
    expect(Steering.empty().items).toEqual([])
  })

  it("keeps queue-class inserts out of the immutable steer cutoff", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: 1,
        message: ModelRequest.Message.user("steer")
      }),
      {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 1,
        message: ModelRequest.Message.user("queued")
      }
    )
    const drained = Steering.drainAtClose(queue, 1)

    expect(drained.inserts).toEqual([ModelRequest.Message.user("steer")])
    expect(drained.remaining.items).toEqual([
      {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 1,
        message: ModelRequest.Message.user("queued")
      }
    ])
    expect(Object.isFrozen(drained.remaining)).toBe(true)
    expect(Object.isFrozen(drained.remaining.items)).toBe(true)
    expect(queue.items).toHaveLength(2)
  })

  it("promotes a queue insert only when the turn would otherwise idle", () => {
    const queue = Steering.enqueue(Steering.empty(), {
      _tag: "Insert",
      delivery: "queue",
      admittedAt: 1,
      message: ModelRequest.Message.user("queued")
    })

    expect(Steering.promoteAtIdle({ queue, wouldIdle: false, steerContinued: false })).toBeUndefined()
    expect(Steering.promoteAtIdle({ queue, wouldIdle: true, steerContinued: true })).toBeUndefined()
    expect(Steering.promoteAtIdle({ queue, wouldIdle: true, steerContinued: false })).toMatchObject({
      delivery: "queue",
      message: ModelRequest.Message.user("queued")
    })
  })

  it("returns exactly the oldest eligible queue insert", () => {
    const queue = Steering.enqueue(
      Steering.enqueue(Steering.empty(), {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 1,
        message: ModelRequest.Message.user("one")
      }),
      {
        _tag: "Insert",
        delivery: "queue",
        admittedAt: 2,
        message: ModelRequest.Message.user("two")
      }
    )

    expect(
      Steering.promoteAtIdle({
        queue,
        wouldIdle: true,
        steerContinued: false
      })?.message
    ).toEqual(ModelRequest.Message.user("one"))
  })
})
