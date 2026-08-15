/**
 * Idempotent admission of collaborative commands onto a branch document.
 *
 * Three different things look identical from the server's side — an optimistic
 * client re-sending after a timeout, a reconnecting client flushing its
 * outbox, and two people pressing the same button at once — and all three must
 * produce exactly one durable command. The client-minted `commandId` is the
 * idempotency key for all three.
 *
 * The exactly-once constraint is durable, not process-local: every append
 * carries the producer identity `(branch run, commandSourceId(commandId),
 * commandSourceSeq)`, which the journal enforces inside its own write
 * transaction. Two independently constructed servers that race the same
 * command therefore collide in the journal — one appends, the other receives
 * a duplicate receipt or an idempotency conflict and resolves the canonical
 * sequence by replaying the branch (audit finding F-14). The in-memory
 * ledger, permit, and replay cursor are a fast path only: they answer known
 * duplicates without a journal write and keep a restarted server from
 * re-executing history, but correctness never depends on them.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal-next"
import * as JournalEvent from "@smthrs/journal-next/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import {
  type BranchId,
  branchRunId,
  CommandEvent,
  type CommandId,
  CommandIdentity,
  CommandReceipt,
  commandSourceId,
  commandSourceSeq,
  CommandSubmission,
  ShareCapability
} from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import { SyncError } from "./SyncError.ts"

/**
 * A capability-bearing command submission.
 *
 * @category models
 * @since 0.1.0
 */
export const SubmitRequest = Schema.Struct({ capability: ShareCapability, submission: CommandSubmission })
/**
 * The value form of {@link SubmitRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type SubmitRequest = typeof SubmitRequest.Type

/**
 * Branch command admission operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly submit: (request: SubmitRequest) => Effect.Effect<CommandReceipt, SyncError>
}

/**
 * The branch command ledger.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchCommands extends Context.Service<BranchCommands, Service>()("@smthrs/sync-next/BranchCommands") {}

/**
 * Constructs a command ledger from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => BranchCommands.of(implementation)

/**
 * Constructs a command ledger that admits nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    submit: () => Effect.fail(new SyncError({ code: "closed", message: "Branch commands are unavailable" })),
    ...overrides
  })

/**
 * Provides a command ledger that admits nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchCommands> = Layer.succeed(BranchCommands, makeNoop())

const journalFailure = (cause: unknown): SyncError =>
  new SyncError({
    code: "unknown",
    message: cause instanceof Error ? cause.message : "Branch journal write failed",
    cause
  })

const ledgerKey = (branchId: BranchId, commandId: CommandId): string => `${branchId} ${commandId}`

/** How many entries one rehydration page reads. */
const pageSize = 256

/**
 * Constructs the journal-backed branch command ledger.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive: Effect.Effect<Service, never, Journal.Journal | BranchShare.BranchShare> = Effect.gen(
  function*() {
    const journal = yield* Journal.Journal
    const share = yield* BranchShare.BranchShare
    const permit = yield* Semaphore.make(1)
    const ledger = new Map<string, CommandReceipt>()
    const cursors = new Map<BranchId, JournalEvent.Seq>()
    const hydrated = new Set<BranchId>()

    const duplicateOf = (known: CommandReceipt): CommandReceipt =>
      new CommandReceipt({
        branchId: known.branchId,
        commandId: known.commandId,
        status: "duplicate",
        seq: known.seq
      })

    /**
     * Replays the branch journal forward from the last replayed sequence into
     * the ledger. Used once on first touch, so a process that restarts
     * mid-collaboration still recognises every command it already admitted,
     * and again after an admission conflict, to read the command another
     * writer admitted after this process last looked.
     */
    const replay = (branchId: BranchId): Effect.Effect<void, SyncError> =>
      Effect.gen(function*() {
        const runId = branchRunId(branchId)
        let after = cursors.get(branchId)
        let hasMore = true
        while (hasMore) {
          const page = yield* journal.entries({
            runId,
            ...(after === undefined ? {} : { after }),
            limit: pageSize
          }).pipe(Effect.mapError(journalFailure))
          for (const entry of page.entries) {
            after = entry.seq
            cursors.set(branchId, entry.seq)
            const submission = entry.eventType === CommandEvent
              ? Schema.decodeUnknownOption(CommandIdentity)(entry.payload)
              : Option.none()
            if (Option.isSome(submission)) {
              ledger.set(
                ledgerKey(branchId, submission.value.commandId),
                new CommandReceipt({
                  branchId,
                  commandId: submission.value.commandId,
                  status: "admitted",
                  seq: entry.seq
                })
              )
            }
          }
          hasMore = page.hasMore
        }
      })

    const hydrate = (branchId: BranchId): Effect.Effect<void, SyncError> =>
      Effect.gen(function*() {
        if (hydrated.has(branchId)) return
        yield* replay(branchId)
        hydrated.add(branchId)
      })

    /**
     * The losing side of a cross-server admission race: the journal refused
     * this append because another writer already holds the command's producer
     * identity with different content — same `commandId`, different
     * participant or arguments. The original admission is durable, so
     * replaying the branch forward must surface it; a replay that does not is
     * a journal whose conflict report and entries disagree, and that failure
     * is reported honestly instead of being masked as a duplicate.
     */
    const lostRace = (
      submission: CommandSubmission,
      cause: Journal.JournalError
    ): Effect.Effect<CommandReceipt, SyncError> =>
      Effect.gen(function*() {
        yield* replay(submission.branchId)
        const known = ledger.get(ledgerKey(submission.branchId, submission.commandId))
        if (known === undefined) return yield* Effect.fail(journalFailure(cause))
        return duplicateOf(known)
      })

    const admit = (request: SubmitRequest): Effect.Effect<CommandReceipt, SyncError> =>
      Effect.gen(function*() {
        const submission = request.submission
        yield* hydrate(submission.branchId)
        const known = ledger.get(ledgerKey(submission.branchId, submission.commandId))
        if (known !== undefined) return duplicateOf(known)
        const receipt = yield* journal.emitDurable(
          new JournalEvent.Input({
            runId: branchRunId(submission.branchId),
            sourceId: commandSourceId(submission.commandId),
            sourceSeq: commandSourceSeq,
            eventType: CommandEvent,
            payload: {
              branchId: submission.branchId,
              commandId: submission.commandId,
              participantId: submission.participantId,
              name: submission.name,
              args: submission.args,
              target: submission.target
            },
            meta: null
          })
        ).pipe(
          // A `Duplicate` receipt is another writer landing the identical
          // submission first: the journal deduplicated durably and returned
          // the canonical sequence the original append committed at.
          Effect.map((accepted) =>
            new CommandReceipt({
              branchId: submission.branchId,
              commandId: submission.commandId,
              status: accepted._tag === "Duplicate" ? "duplicate" : "admitted",
              seq: accepted.seq
            })
          ),
          Effect.catch((cause) =>
            cause.code === "idempotency_conflict"
              ? lostRace(submission, cause)
              : Effect.fail(journalFailure(cause))
          )
        )
        ledger.set(
          ledgerKey(submission.branchId, submission.commandId),
          new CommandReceipt({
            branchId: submission.branchId,
            commandId: submission.commandId,
            status: "admitted",
            seq: receipt.seq
          })
        )
        return receipt
      })

    const submit = Effect.fn("BranchCommands.submit")(function*(request: SubmitRequest) {
      yield* Effect.annotateCurrentSpan({
        branchId: request.submission.branchId,
        commandId: request.submission.commandId,
        participantId: request.submission.participantId
      })
      yield* share.verify(request.capability, { branchId: request.submission.branchId, access: "write" })
      // The permit is taken AFTER authorization so an unauthorized caller
      // cannot serialize (and therefore stall) legitimate collaborators.
      return yield* permit.withPermits(1)(admit(request))
    })

    return make({ submit })
  }
)

/**
 * Provides the journal-backed branch command ledger.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BranchCommands, never, Journal.Journal | BranchShare.BranchShare> = Layer.effect(
  BranchCommands,
  makeLive
)

/**
 * Builds a submission, filling in the fields a plain command never sets.
 *
 * @category constructors
 * @since 0.1.0
 */
export const submission = (fields: {
  readonly branchId: BranchId
  readonly commandId: CommandId
  readonly participantId: CommandSubmission["participantId"]
  readonly name: string
  readonly args?: string
  readonly target?: string
}): CommandSubmission =>
  new CommandSubmission({
    branchId: fields.branchId,
    commandId: fields.commandId,
    participantId: fields.participantId,
    name: fields.name,
    args: fields.args ?? "",
    target: fields.target ?? ""
  })
