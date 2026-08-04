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
import type * as JournalEvent from "@smithers/journal/JournalEvent"
import {
  type BranchId,
  branchRunId,
  CommandEvent,
  type CommandId,
  type ParticipantId,
  SayCommand
} from "./BranchProtocol.ts"

/**
 * One collaborative chat message in the branch timeline.
 *
 * @category models
 * @since 0.1.0
 */
export interface Message {
  readonly seq: JournalEvent.Seq
  readonly commandId: CommandId
  readonly participantId: ParticipantId
  readonly text: string
}

/**
 * One command applied to the branch document.
 *
 * @category models
 * @since 0.1.0
 */
export interface AppliedCommand {
  readonly seq: JournalEvent.Seq
  readonly commandId: CommandId
  readonly participantId: ParticipantId
  readonly name: string
  readonly args: string
  readonly target: string
}

/**
 * The current winning value of one durably edited shared field.
 *
 * @category models
 * @since 0.1.0
 */
export interface Field {
  readonly target: string
  readonly value: string
  readonly seq: JournalEvent.Seq
  readonly participantId: ParticipantId
}

/**
 * The projected state of one branch document.
 *
 * `seq` is the highest journal sequence folded in and is exactly the cursor a
 * client resumes from.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly branchId: BranchId
  readonly seq: number
  readonly messages: ReadonlyArray<Message>
  readonly commands: ReadonlyArray<AppliedCommand>
  readonly fields: ReadonlyArray<Field>
}

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

interface Decoded {
  readonly commandId: CommandId
  readonly participantId: ParticipantId
  readonly name: string
  readonly args: string
  readonly target: string
}

const string = (source: Record<string, unknown>, field: string): string | null => {
  const value = source[field]
  return typeof value === "string" ? value : null
}

/** A payload the branch never wrote is not a command; the fold skips it. */
const decode = (payload: unknown): Decoded | null => {
  if (typeof payload !== "object" || payload === null) return null
  const source = payload as Record<string, unknown>
  const commandId = string(source, "commandId")
  const participantId = string(source, "participantId")
  const name = string(source, "name")
  if (commandId === null || participantId === null || name === null) return null
  return {
    commandId: commandId as CommandId,
    participantId: participantId as ParticipantId,
    name,
    args: string(source, "args") ?? "",
    target: string(source, "target") ?? ""
  }
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
  const decoded = decode(entry.payload)
  if (decoded === null) return advanced
  if (state.commands.some((command) => command.commandId === decoded.commandId)) return advanced
  const command: AppliedCommand = { ...decoded, seq: entry.seq }
  const messages = decoded.name === SayCommand
    ? [...state.messages, {
      seq: entry.seq,
      commandId: decoded.commandId,
      participantId: decoded.participantId,
      text: decoded.args
    }]
    : state.messages
  const fields = decoded.target === ""
    ? state.fields
    : (() => {
      const candidate: Field = {
        target: decoded.target,
        value: decoded.args,
        seq: entry.seq,
        participantId: decoded.participantId
      }
      const winner = resolveField(state.fields.find((field) => field.target === decoded.target), candidate)
      return [...state.fields.filter((field) => field.target !== decoded.target), winner]
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
