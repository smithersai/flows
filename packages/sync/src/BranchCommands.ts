/**
 * Idempotent admission of collaborative commands onto a branch document.
 *
 * Three different things look identical from the server's side — an optimistic
 * client re-sending after a timeout, a reconnecting client flushing its
 * outbox, and two people pressing the same button at once — and all three must
 * produce exactly one durable command. The client-minted `commandId` is the
 * idempotency key for all three, a permit serializes admission so a race
 * cannot append twice, and the ledger is rehydrated from the branch journal on
 * first use so a restarted server does not re-execute history.
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
  CommandSubmission,
  participantSourceId,
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
    const hydrated = new Set<BranchId>()

    /**
     * Replays the branch's own journal into the ledger once, so a process that
     * restarts mid-collaboration still recognises every command it already
     * admitted instead of executing it a second time.
     */
    const hydrate = (branchId: BranchId): Effect.Effect<void, SyncError> =>
      Effect.gen(function*() {
        if (hydrated.has(branchId)) return
        const runId = branchRunId(branchId)
        let after: JournalEvent.Seq | undefined
        let hasMore = true
        while (hasMore) {
          const page = yield* journal.entries({
            runId,
            ...(after === undefined ? {} : { after }),
            limit: pageSize
          }).pipe(Effect.mapError(journalFailure))
          for (const entry of page.entries) {
            after = entry.seq
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
        hydrated.add(branchId)
      })

    const admit = (request: SubmitRequest): Effect.Effect<CommandReceipt, SyncError> =>
      Effect.gen(function*() {
        const submission = request.submission
        yield* hydrate(submission.branchId)
        const known = ledger.get(ledgerKey(submission.branchId, submission.commandId))
        if (known !== undefined) {
          return new CommandReceipt({
            branchId: known.branchId,
            commandId: known.commandId,
            status: "duplicate",
            seq: known.seq
          })
        }
        const accepted = yield* journal.emitDurable(
          new JournalEvent.Input({
            runId: branchRunId(submission.branchId),
            sourceId: participantSourceId(submission.participantId),
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
        ).pipe(Effect.mapError(journalFailure))
        const receipt = new CommandReceipt({
          branchId: submission.branchId,
          commandId: submission.commandId,
          status: "admitted",
          seq: accepted.seq
        })
        ledger.set(ledgerKey(submission.branchId, submission.commandId), receipt)
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
