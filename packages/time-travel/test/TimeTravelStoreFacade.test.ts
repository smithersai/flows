import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const frame = { lineageId: "main", seq: 1 } as const

describe("TimeTravelStore.makeNoop", () => {
  it("fails every method with `unknown`, naming the method that was called", async () => {
    const store = TimeTravelStore.makeNoop()
    const calls = [
      ["snapshotAt", store.snapshotAt("run", frame)],
      ["descendants", store.descendants("run", frame)],
      ["writeAudit", store.writeAudit({ id: "a", runId: "run", frame, status: "in_progress" })],
      ["updateAudit", store.updateAudit("a", { status: "completed" })],
      ["pendingAudits", store.pendingAudits()],
      ["archiveAndTruncate", store.archiveAndTruncate("run", frame, [])],
      ["createFork", store.createFork("run", frame)],
      ["recordReceipt", store.recordReceipt({ id: "r", auditId: "a", effectId: "e", receipt: {} })]
    ] as const

    for (const [method, effect] of calls) {
      const error = await Effect.runPromise(Effect.flip(effect as Effect.Effect<unknown, unknown>))
      expect(error).toMatchObject({ code: "unknown", message: `${method} is unavailable` })
    }
  })

  it("keeps overridden methods and leaves the rest unavailable", async () => {
    const layer = TimeTravelStore.layerNoop({
      snapshotAt: (runId, at) => Effect.succeed({ runId, frame: at, changeId: "change" })
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TimeTravelStore.TimeTravelStore
        const snapshot = yield* store.snapshotAt("run", frame)
        const failed = yield* Effect.flip(store.pendingAudits())
        return { snapshot, failed }
      }).pipe(Effect.provide(layer))
    )

    expect(result.snapshot).toEqual({ runId: "run", frame, changeId: "change" })
    expect(result.failed).toMatchObject({ code: "unknown", message: "pendingAudits is unavailable" })
  })

  it("returns the implementation unchanged from `make`", () => {
    const service = TimeTravelStore.makeNoop()
    expect(TimeTravelStore.make(service)).toStrictEqual(service)
  })
})
