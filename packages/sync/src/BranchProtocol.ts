/**
 * The branch collaboration contract: a branch is one shared live document.
 *
 * A branch has no store of its own. Its durable state is exactly one journal
 * run — `branchRunId` is the only mapping — so every replication guarantee the
 * rest of this package already provides (canonical per-run `seq`, exclusive
 * cursors, gap detection, resumable follow) carries over unchanged, and
 * multiplayer never introduces a second source of truth.
 *
 * Ephemeral collaboration state (presence, cursors) deliberately has no
 * representation here beyond the wire shapes: it is leased, never journalled.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Schema for the identifier of one collaboratively edited branch.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BranchId = Schema.NonEmptyString.pipe(Schema.brand("flows/sync/BranchId"))

/**
 * Identifier of one collaboratively edited branch.
 *
 * @category models
 * @since 0.1.0
 */
export type BranchId = typeof BranchId.Type

/**
 * Schema for the identifier of one connected client.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ParticipantId = Schema.NonEmptyString.pipe(Schema.brand("flows/sync/ParticipantId"))

/**
 * Identifier of one connected client.
 *
 * @category models
 * @since 0.1.0
 */
export type ParticipantId = typeof ParticipantId.Type

/**
 * Schema for a client-minted command identifier.
 *
 * The identifier is minted once per user intent and reused across optimistic
 * application, retransmission, and concurrent submission, which is what makes
 * it the idempotency key rather than a correlation id.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CommandId = Schema.NonEmptyString.pipe(Schema.brand("flows/sync/CommandId"))

/**
 * Client-minted command identifier used as the idempotency key.
 *
 * @category models
 * @since 0.1.0
 */
export type CommandId = typeof CommandId.Type

/**
 * Schema for the access a share capability grants.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Access = Schema.Literals(["read", "write"])

/**
 * The access a share capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type Access = typeof Access.Type

/**
 * The journal run backing a branch document.
 *
 * The prefix keeps branch runs from colliding with engine runs in the same
 * workspace journal, and makes the mapping reversible for tooling.
 *
 * @category constructors
 * @since 0.1.0
 */
export const branchRunId = (branchId: BranchId): JournalEvent.RunId => `flows/branch/${branchId}` as JournalEvent.RunId

/**
 * The branch a journal run belongs to, or `null` for a non-branch run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const branchOfRunId = (runId: JournalEvent.RunId): BranchId | null =>
  runId.startsWith("flows/branch/") ? runId.slice("flows/branch/".length) as BranchId : null

/**
 * The journal producer identity of one participant.
 *
 * `(runId, sourceId, sourceSeq)` is the journal's own idempotency key, so
 * giving every participant a distinct source keeps two clients submitting
 * concurrently from ever colliding on it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const participantSourceId = (participantId: ParticipantId): JournalEvent.SourceId =>
  `flows/participant/${participantId}` as JournalEvent.SourceId

/**
 * The single durable event type a branch document is built from.
 *
 * Chat, edits, and flow launches are all commands, so the branch journal has
 * exactly one event shape and the projection has exactly one decoder.
 *
 * @category models
 * @since 0.1.0
 */
export const CommandEvent = "flows/branch/command"

/**
 * Schema for the claims a share capability carries.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ShareClaims extends Schema.Class<ShareClaims>("flows/sync/BranchProtocol/ShareClaims")({
  branchId: BranchId,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  issuedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for a signed, expiring, branch-scoped share capability.
 *
 * @category schemas
 * @since 0.1.0
 */
export class ShareCapability extends Schema.Class<ShareCapability>("flows/sync/BranchProtocol/ShareCapability")({
  claims: ShareClaims,
  signature: Schema.String
}) {}

/**
 * Schema for a participant's caret inside one embedded card.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Cursor extends Schema.Class<Cursor>("flows/sync/BranchProtocol/Cursor")({
  cardId: Schema.NonEmptyString,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for one live participant on a branch.
 *
 * `leaseExpiresAtMs` is the whole lifetime contract: presence is a lease, so a
 * client that disconnects without saying so disappears on its own.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Participant extends Schema.Class<Participant>("flows/sync/BranchProtocol/Participant")({
  branchId: BranchId,
  participantId: ParticipantId,
  displayName: Schema.NonEmptyString,
  cursor: Schema.NullOr(Cursor),
  leaseExpiresAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for one submitted command or flow invocation.
 *
 * Every user action on a shared branch arrives here first — chat messages are
 * the `branch.say` command, renames are `branch.rename`, and a flow launch is
 * that flow's own name. `target` names the shared field a command durably
 * edits and is `""` for commands that only append.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandSubmission extends Schema.Class<CommandSubmission>(
  "flows/sync/BranchProtocol/CommandSubmission"
)({
  branchId: BranchId,
  commandId: CommandId,
  participantId: ParticipantId,
  name: Schema.NonEmptyString,
  args: Schema.String,
  target: Schema.String
}) {}

/**
 * The durable payload stored for an admitted command.
 *
 * Distinct from the wire request: `args` and `target` carry decoding defaults,
 * so a row written before those fields existed still decodes rather than
 * failing the whole ledger rebuild.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandEventPayload extends Schema.Class<CommandEventPayload>(
  "flows/sync/BranchProtocol/CommandEventPayload"
)({
  commandId: CommandId,
  participantId: ParticipantId,
  name: Schema.NonEmptyString,
  args: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  target: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
}) {}

/**
 * The one field a ledger rebuild needs from a stored command: its id.
 *
 * Kept as its own schema so the rebuild decodes only what it uses — a payload
 * whose other fields have since changed shape still yields its identity.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandIdentity extends Schema.Class<CommandIdentity>(
  "flows/sync/BranchProtocol/CommandIdentity"
)({
  commandId: CommandId
}) {}

/**
 * The command that appends a collaborative chat message.
 *
 * @category models
 * @since 0.1.0
 */
export const SayCommand = "branch.say"

/**
 * Schema for the outcome of admitting a command.
 *
 * `duplicate` is a success, not a failure: it reports the canonical sequence
 * the original submission already occupies so a retransmitting client can
 * settle its optimistic row instead of executing the command twice.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CommandReceipt extends Schema.Class<CommandReceipt>("flows/sync/BranchProtocol/CommandReceipt")({
  branchId: BranchId,
  commandId: CommandId,
  status: Schema.Literals(["admitted", "duplicate"]),
  seq: JournalEvent.Seq
}) {}
