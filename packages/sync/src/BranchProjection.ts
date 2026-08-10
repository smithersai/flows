/**
 * The branch document projection: journal entries folded into what two people
 * looking at the same branch must agree on.
 *
 * The fold is a pure function of the canonical `(runId, seq)` order, which is
 * what makes convergence a property rather than a hope: any two clients that
 * have applied the same prefix hold the same state, regardless of the order
 * their transports delivered frames in or how many times a frame arrived.
 *
 * Three guards do all the work, and each is a production invariant:
 *
 * - entries from another branch's run are ignored, so a mis-routed frame can
 *   never leak into a projection;
 * - entries at or below the applied sequence are ignored, so re-reading after
 *   a reconnect replays no side effects;
 * - a command id already applied is ignored, so an at-least-once transport
 *   cannot double-apply a user action.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  BranchId,
  branchRunId,
  CommandEvent,
  CommandEventPayload,
  CommandId,
  ParticipantId,
  SayCommand
} from "./BranchProtocol.ts"

/**
 * One collaborative chat message in the branch timeline.
 *
 * @category models
 * @since 0.1.0
 */
export const Message = Schema.Struct({
  seq: JournalEvent.Seq,
  commandId: CommandId,
  participantId: ParticipantId,
  text: Schema.String
})
/** @category models @since 0.1.0 */
export type Message = typeof Message.Type

/**
 * One command applied to the branch document.
 *
 * @category models
 * @since 0.1.0
 */
export const AppliedCommand = Schema.Struct({
  seq: JournalEvent.Seq,
  commandId: CommandId,
  participantId: ParticipantId,
  name: Schema.NonEmptyString,
  args: Schema.String,
  target: Schema.String
})
/** @category models @since 0.1.0 */
export type AppliedCommand = typeof AppliedCommand.Type

/**
 * The current winning value of one durably edited shared field.
 *
 * @category models
 * @since 0.1.0
 */
export const Field = Schema.Struct({
  target: Schema.NonEmptyString,
  value: Schema.String,
  seq: JournalEvent.Seq,
  participantId: ParticipantId
})
/** @category models @since 0.1.0 */
export type Field = typeof Field.Type

/**
 * The projected state of one branch document.
 *
 * `seq` is the highest journal sequence folded in and is exactly the cursor a
 * client resumes from.
 *
 * @category models
 * @since 0.1.0
 */
export const State = Schema.Struct({
  branchId: BranchId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  messages: Schema.Array(Message),
  commands: Schema.Array(AppliedCommand),
  fields: Schema.Array(Field)
})
/** @category models @since 0.1.0 */
export type State = typeof State.Type

/**
 * The empty projection of a branch, whose cursor is "nothing applied".
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty = (branchId: BranchId): State => ({
  branchId,
  seq: -1,
  messages: [],
  commands: [],
  fields: []
})

/**
 * The conflict policy for two durable edits of the same field.
 *
 * Highest canonical sequence wins. Within a branch the sequence is a total
 * order assigned by the journal, so this is already decisive; the
 * lexicographic `participantId` tie-break exists so the policy stays total if
 * a future deployment ever merges two sequence domains. It is deliberately not
 * wall-clock based — client clocks disagree, and a merge rule that depends on
 * them is not deterministic.
 *
 * @category combinators
 * @since 0.1.0
 */
export const resolveField = (existing: Field | undefined, candidate: Field): Field => {
  if (existing === undefined) return candidate
  if (candidate.seq !== existing.seq) return candidate.seq > existing.seq ? candidate : existing
  return candidate.participantId > existing.participantId ? candidate : existing
}

/**
 * Folds one journal entry into a branch projection.
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = (state: State, entry: JournalEvent.Entry): State => {
  if (entry.runId !== branchRunId(state.branchId) || entry.seq <= state.seq) return state
  const advanced = { ...state, seq: entry.seq }
  if (entry.eventType !== CommandEvent) return advanced
  const decoded = Schema.decodeUnknownOption(CommandEventPayload)(entry.payload)
  if (Option.isNone(decoded)) return advanced
  const commandSubmission = decoded.value
  if (state.commands.some((command) => command.commandId === commandSubmission.commandId)) return advanced
  const command: AppliedCommand = { ...commandSubmission, seq: entry.seq }
  const messages = commandSubmission.name === SayCommand
    ? [...state.messages, {
      seq: entry.seq,
      commandId: commandSubmission.commandId,
      participantId: commandSubmission.participantId,
      text: commandSubmission.args
    }]
    : state.messages
  const fields = commandSubmission.target === ""
    ? state.fields
    : (() => {
      const candidate: Field = {
        target: commandSubmission.target,
        value: commandSubmission.args,
        seq: entry.seq,
        participantId: commandSubmission.participantId
      }
      const winner = resolveField(
        state.fields.find((field) => field.target === commandSubmission.target),
        candidate
      )
      return [...state.fields.filter((field) => field.target !== commandSubmission.target), winner]
        .sort((left, right) => left.target < right.target ? -1 : 1)
    })()
  return { ...advanced, messages, commands: [...state.commands, command], fields }
}

/**
 * Folds a whole entry stream into a branch projection.
 *
 * @category combinators
 * @since 0.1.0
 */
export const project = (branchId: BranchId, entries: Iterable<JournalEvent.Entry>): State => {
  let state = empty(branchId)
  for (const entry of entries) state = apply(state, entry)
  return state
}
