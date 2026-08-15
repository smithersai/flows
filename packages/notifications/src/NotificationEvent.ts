/**
 * Journal event types owned by the notification queue.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal-next"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Notification from "./Notification.ts"

/**
 * The journal `eventType` recorded for one admission decision.
 *
 * @category constants
 * @since 0.1.0
 */
export const AdmittedEventType = "flows/notifications/Admitted"

/**
 * The journal `eventType` recorded when pending notifications are promoted.
 *
 * @category constants
 * @since 0.1.0
 */
export const PromotedEventType = "flows/notifications/Promoted"

/**
 * A durable admission record.
 *
 * @category models
 * @since 0.1.0
 */
const AdmissionDecision = Schema.Literals(["admitted", "coalesced", "rejected-full"])

export const Admitted = Schema.Struct({
  notification: Notification.Notification,
  decision: AdmissionDecision
})

export type Admitted = typeof Admitted.Type

/**
 * A durable promotion record.
 *
 * @category models
 * @since 0.1.0
 */
export const Promoted = Schema.Struct({
  boundary: Schema.String,
  targetLineageId: Schema.String,
  ids: Schema.Array(Schema.String)
})

export type Promoted = typeof Promoted.Type

/**
 * Any journal event owned by this package.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = Admitted | Promoted

const decodeAdmitted = Schema.decodeUnknownOption(Admitted)
const decodePromoted = Schema.decodeUnknownOption(Promoted)

/**
 * Decodes an owned notification event from a journal entry.
 *
 * Foreign entries and structurally invalid payloads decode to `None` so a
 * projection over a shared journal stays total.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromEntry = (entry: JournalEvent.Entry): Option.Option<Event> => {
  if (entry.eventType === AdmittedEventType) {
    return decodeAdmitted(entry.payload)
  }
  if (entry.eventType === PromotedEventType) {
    return decodePromoted(entry.payload)
  }
  return Option.none()
}
