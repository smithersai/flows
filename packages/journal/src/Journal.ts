/**
 * Non-blocking durable journal contract.
 *
 * Governing design: `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { Entry, Input, RunId, Seq, SourceSeq } from "./JournalEvent.ts"
import type { Projection } from "./Projection.ts"

/**
 * Stable error codes returned by journal operations.
 *
 * @category models
 * @since 0.1.0
 */
export const JournalErrorCode = Schema.Literals([
  "invalid_event",
  "idempotency_conflict",
  "sequence_conflict",
  "queue_overflow",
  "journal_closed",
  "sink_failed",
  "decode_failed",
  "projection_failed",
  "unknown"
])

/**
 * Stable error codes returned by journal operations.
 *
 * @category models
 * @since 0.1.0
 */
export type JournalErrorCode = typeof JournalErrorCode.Type

/**
 * Error raised by journal admission, persistence, replay, or projection.
 *
 * @category errors
 * @since 0.1.0
 */
export class JournalError extends Schema.TaggedErrorClass<JournalError>()("flows/journal/JournalError", {
  code: JournalErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Policy applied when the non-blocking admission queue is full.
 *
 * @category models
 * @since 0.1.0
 */
export type OverflowPolicy = "reject" | "drop-newest" | "drop-oldest"

/**
 * Receipt for a new event admitted to the writer queue.
 *
 * `seq` and `sourceSeq` are allocated synchronously inside `emit` and returned
 * before any SQL, subscriber, telemetry, or queue-capacity wait. `seq` orders
 * the run; `sourceSeq` identifies producer retries.
 *
 * @category models
 * @since 0.1.0
 */
export interface Accepted {
  readonly _tag: "Accepted"
  readonly seq: Seq
  readonly sourceSeq: SourceSeq
  readonly evicted?: {
    readonly policy: "drop-oldest"
    readonly count: number
  } | undefined
}

/**
 * Receipt for an exact retry of an already pending or committed source event.
 *
 * `seq` is the original event's canonical sequence. A duplicate does not
 * allocate another sequence or enqueue another write. `status` distinguishes
 * an optimistic retry from one whose original event is already durable.
 *
 * @category models
 * @since 0.1.0
 */
export interface Duplicate {
  readonly _tag: "Duplicate"
  readonly seq: Seq
  readonly sourceSeq: SourceSeq
  readonly status: "pending" | "committed"
}

/**
 * Receipt for an event discarded by an explicit dropping policy.
 *
 * A dropped admission still consumes its synchronously allocated `seq` and
 * `sourceSeq`, so sequence gaps are expected.
 *
 * @category models
 * @since 0.1.0
 */
export interface Dropped {
  readonly _tag: "Dropped"
  readonly seq: Seq
  readonly sourceSeq: SourceSeq
  readonly policy: "drop-newest"
}

/**
 * Result of a non-blocking journal admission attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type EmitReceipt = Accepted | Duplicate | Dropped

/**
 * Cursor used to replay a run and then follow its committed tail.
 *
 * @category models
 * @since 0.1.0
 */
export interface StreamOptions {
  readonly runId: RunId
  readonly afterSequence?: Seq | undefined
}

/**
 * Cursor and page size for durable journal reads.
 *
 * @category models
 * @since 0.1.0
 */
export interface EntriesOptions {
  readonly runId: RunId
  readonly after?: Seq | undefined
  readonly limit: number
}

/**
 * One page of canonical durable journal entries.
 *
 * @category models
 * @since 0.1.0
 */
export interface EntriesPage {
  readonly entries: ReadonlyArray<Entry>
  readonly hasMore: boolean
}

/**
 * Journal operations.
 *
 * There are two sequence domains:
 *
 * - `seq` is assigned synchronously inside `emit` per run. It is the canonical
 *   durable order used by replay, paging, streams, and projections.
 * - `sourceSeq` is assigned synchronously per `(runId, sourceId)` and is the
 *   idempotency key for producer retries.
 *
 * Rejected or dropped admissions consume both allocations, so gaps are valid.
 * Exact retries return `Duplicate` with the original canonical `seq` and do
 * not consume either allocation.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly emit: (input: Input) => Effect.Effect<EmitReceipt, JournalError>
  readonly stream: (options: StreamOptions) => Stream.Stream<Entry, JournalError>
  readonly entries: (options: EntriesOptions) => Effect.Effect<EntriesPage, JournalError>
  readonly changes: Effect.Effect<PubSub.Subscription<Entry>, never, Scope.Scope>
  readonly project: <S, E, R>(
    projection: Projection<S, E, R>,
    options: StreamOptions
  ) => Stream.Stream<S, JournalError, R>
  readonly flush: Effect.Effect<void, JournalError>
}

/**
 * Context service for non-blocking durable journaling.
 *
 * @category services
 * @since 0.1.0
 */
export class Journal extends Context.Service<Journal, Service>()("flows/journal/Journal") {}

/**
 * Constructs a journal service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => Journal.of(implementation)

const unavailable = (method: string): JournalError =>
  new JournalError({
    code: "journal_closed",
    message: `${method} is unavailable`
  })

/**
 * Constructs a closed journal stub, optionally overriding individual methods.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const service: Service = {
    emit: Effect.fn("Journal.emit")(() => Effect.fail(unavailable("emit"))),
    stream: (options) =>
      Stream.unwrap(
        Effect.fn("Journal.stream")((_options: StreamOptions) => Effect.succeed(Stream.fail(unavailable("stream"))))(
          options
        )
      ),
    entries: Effect.fn("Journal.entries")(() => Effect.fail(unavailable("entries"))),
    changes: Effect.acquireRelease(
      PubSub.sliding<Entry>(1),
      PubSub.shutdown
    ).pipe(Effect.flatMap(PubSub.subscribe)),
    project: (projection, options) =>
      Stream.unwrap(
        Effect.fn("Journal.project")(
          <S, E, R>(_projection: Projection<S, E, R>, _options: StreamOptions) =>
            Effect.succeed(Stream.fail(unavailable("project")))
        )(projection, options)
      ),
    flush: Effect.fn("Journal.flush")(() => Effect.fail(unavailable("flush")))()
  }
  return Journal.of({ ...service, ...overrides })
}

/**
 * Provides a closed journal stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Journal> =>
  Layer.succeed(Journal)(makeNoop(overrides))
