import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import type * as NotificationModel from "@smthrs/notifications/Notification"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Notifications from "../src/Notifications.ts"

const notificationLayer = (() => {
  const journal = TestJournal.layer()
  return Layer.merge(journal, NotificationQueue.layer.pipe(Layer.provide(journal)))
})()

const notification = (
  id: string,
  delivery: "steer" | "queue",
  targetLineageId: string
): NotificationModel.Notification => {
  const base = {
    id,
    targetLineageId,
    provenance: {
      sourceRunId: "operator",
      sourceLineageId: "operator/root",
      sourceTurn: 7,
      sourceActor: "human:operator"
    },
    payload: { body: `body:${id}` }
  }
  return delivery === "steer"
    ? { _tag: "human-steer", delivery, ...base }
    : { _tag: "human-followup", delivery, ...base }
}

describe("harness notification adapter", () => {
  it("drains the target lineage at turn boundaries with queue semantics and provenance", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit("run", notification("steer", "steer", "run/root/child"))
        yield* queue.admit("run", notification("queued", "queue", "run/root/child"))
        yield* queue.admit("run", notification("other", "steer", "run/root/other"))
        const source = yield* Notifications.make({ runId: "run", lineageId: "run/root/child" })
        const active = yield* source.drain({ boundary: "child/turn-1", wouldIdle: false })
        const idle = yield* source.drain({ boundary: "child/turn-2", wouldIdle: true })
        return { active, idle }
      }).pipe(
        Effect.provide(notificationLayer),
        Effect.scoped
      )
    )

    expect(result.active.queued).toBe(false)
    expect(result.active.inserts[0]).toMatchObject({
      role: "user",
      content: [{
        text: expect.stringContaining(
          "[notification steer from human:operator at operator/root turn 7]\nbody:steer"
        )
      }]
    })
    expect(result.idle.queued).toBe(true)
    expect(result.idle.inserts[0]).toMatchObject({
      content: [{ text: expect.stringContaining("body:queued") }]
    })
  })
})
