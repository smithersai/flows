/**
 * Adapter from the durable notification queue to harness turn boundaries.
 *
 * Governing contract: `docs/specs/Concepts/Notification Queue.md`.
 *
 * @since 0.1.0
 */
import { NotificationQueue } from "@smthrs/notifications"
import type { Notification } from "@smthrs/notifications/Notification"
import { Effect, Layer } from "effect"
import { HarnessError } from "./HarnessError.ts"
import * as Steering from "./Steering.ts"

/**
 * Which run and lineage this steering source draws notifications for.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly runId: string
  readonly lineageId: string
}

const render = (notification: Notification) => {
  const payload = notification.payload
  const record = typeof payload === "object" &&
      notification.payload !== null &&
      !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined
  const body = typeof record?.["body"] === "string"
    ? record["body"]
    : JSON.stringify(payload)
  return {
    role: "user" as const,
    content: [{
      type: "text" as const,
      text: `[notification ${notification.id} from ${notification.provenance.sourceActor} ` +
        `at ${notification.provenance.sourceLineageId} turn ${notification.provenance.sourceTurn}]\n${body}`
    }]
  }
}

const mapFailure = (cause: unknown): HarnessError =>
  new HarnessError({
    code: "engine_failed",
    message: "The durable notification queue failed at a turn boundary",
    cause
  })

/**
 * Captures the journal-backed queue as the harness steering source for one
 * run lineage.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<Steering.Source, never, NotificationQueue.NotificationQueue> =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    return Steering.make({
      read: () => Effect.succeed(Steering.empty()),
      drain: (input) =>
        queue.drain({
          runId: options.runId,
          targetLineageId: options.lineageId,
          boundary: input.boundary,
          wouldIdle: input.wouldIdle
        }).pipe(
          Effect.map((receipt) => ({
            inserts: receipt.notifications.map(render),
            seatChanges: [],
            activatedToolNames: [],
            remaining: Steering.empty(),
            queued: receipt.notifications.some((notification) => notification.delivery === "queue")
          })),
          Effect.mapError(mapFailure)
        )
    })
  })

/**
 * Provides {@link Steering.Source} backed by the durable notification
 * queue for one run lineage.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<Steering.Source, never, NotificationQueue.NotificationQueue> =>
  Layer.effect(Steering.Source)(make(options))
