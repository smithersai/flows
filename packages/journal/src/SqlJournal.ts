/**
 * SQLite-backed logical journal with durable and lossy channels.
 *
 * Lossy telemetry events remain optimistic until the single scoped writer
 * commits them, so a process crash can lose accepted-but-unwritten telemetry.
 * Lifecycle events use `emitDurable` and return only after commit.
 *
 * Governing design: `docs/specs/Concepts/Journal Queue.md`.
 * Prior-art decision: `docs/specs/Research/Sync Decision 2026-07-28.md`.
 *
 * The replay-then-follow stream follows Effect `EventJournal` and opencode
 * `packages/core/src/event.ts`. The bounded send queue deliberately deviates
 * from their synchronous durable writes by allocating the canonical per-run
 * sequence before admission. SQLite retry and transaction behavior comes
 * through `@smthrs/database`.
 *
 * @since 0.1.0
 */
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import {
  type EmitReceipt,
  type EntriesPage,
  Journal,
  JournalError,
  make as makeJournal,
  type OverflowPolicy,
  type Service,
  type StreamOptions
} from "./Journal.ts"
import { Entry, Input, makeEventId, type RunId, type Seq, type SourceId, type SourceSeq } from "./JournalEvent.ts"
import type { OwnerId } from "./OwnerId.ts"
import type { Projection } from "./Projection.ts"
import * as Redaction from "./Redaction.ts"

/**
 * SQL journal queue and batching options.
 *
 * @category models
 * @since 0.1.0
 */
export interface SqlJournalOptions {
  readonly capacity: number
  readonly overflow: OverflowPolicy
  readonly batchSize?: number | undefined
  /**
   * Upper bound on the in-process source-event index — the map that answers
   * producer idempotency from memory.
   *
   * The index is a cache, never the authority: the writer's `insertOne` always
   * re-checks `flows_journal_events` under the `(run_id, source_id,
   * source_seq)` unique constraint, so an evicted entry re-emitted later is
   * still deduplicated durably and still reports an `idempotency_conflict` on
   * changed content. Bounding it keeps startup decode and resident memory
   * O(bound) rather than O(total events ever written), mirroring Temporal's
   * refusal to hold unbounded history in a shard (`service/history`).
   */
  readonly sourceEventCache?: number | undefined
  /**
   * Scrub applied to every `payload` and `meta` before it is encoded for
   * persistence.
   *
   * Journal rows are permanent and are replayed verbatim to sync subscribers
   * and time-travel consumers, so a credential that reaches `payload_json` is
   * a durable, broadly readable leak. Redaction therefore defaults to
   * `Redaction.make()`; pass `Redaction.makeNoop()` to persist payloads
   * verbatim by choice.
   */
  readonly redact?: Redaction.Redactor | undefined
}

/** Default retained window of the source-event index. */
const defaultSourceEventCache = 4096

interface QueuedEntry {
  readonly runId: RunId
  readonly seq: Seq
  readonly eventId: string
  readonly sourceId: SourceId
  readonly sourceSeq: SourceSeq
  readonly emittedAtMs: number
  readonly eventType: string
  readonly payloadJson: string
  readonly metaJson: string
}

interface JournalRow {
  readonly run_id: string
  readonly seq: number
  readonly event_id: string
  readonly source_id: string
  readonly source_seq: number
  readonly emitted_at_ms: number
  readonly event_type: string
  readonly payload_json: string
  readonly meta_json: string
}

interface SourceSequenceRow {
  readonly run_id: string
  readonly source_id: string
  readonly next_source_seq: number
}

interface SequenceRow {
  readonly run_id: string
  readonly next_seq: number
}

interface Prepared {
  readonly validated: Input
  readonly payloadJson: string
  readonly metaJson: string
}

interface Commit {
  readonly entry: Entry
  readonly inserted: boolean
}

interface SourceEvent {
  readonly seq: Seq
  readonly eventType: string
  readonly payloadJson: string
  readonly metaJson: string
  readonly status: "pending" | "committed"
}

type Status = "open" | "closing" | "closed"

interface State {
  status: Status
  /**
   * The most recent batch the optimistic writer lost. It is a *report*, not a
   * latch: the writer survives a failed batch, so a transient outage must not
   * revoke the lossy channel — or, through `flush`, the durable delivery paths
   * that call it — for the rest of the process's life.
   *
   * Each loss is reported to whoever was waiting on it (`flushWaiters`, live
   * streams) and, via `lossEpoch`, to at most one later `flush` and to every
   * live stream that had not yet observed it. After that the report is spent
   * and the journal is usable again the moment the database is.
   */
  sinkFailure: JournalError | undefined
  /** Incremented on every lost batch; identifies an unreported loss. */
  lossEpoch: number
  /** The highest `lossEpoch` already reported to a `flush` caller. */
  flushedLossEpoch: number
  pending: number
  readonly sequences: Map<RunId, number>
  readonly sourceSequences: Map<string, number>
  readonly sourceEvents: Map<string, SourceEvent>
  readonly flushWaiters: Set<Deferred.Deferred<void, JournalError>>
}

const error = (code: JournalError["code"], message: string, cause?: unknown): JournalError =>
  new JournalError({
    code,
    message,
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Post-commit settlements accumulated while a `transact` transaction is open.
 *
 * `emitDurable` publishes an entry and records it in the in-process
 * source-event index only once the entry is really committed. Inside a
 * transaction the innermost `writer.write` merely releases a savepoint, so
 * those two effects are parked here as thunks and replayed by the outermost
 * `transact` after COMMIT. The parked value is a closure, so several journal
 * instances sharing one transaction each settle their own PubSub and index.
 *
 * This is fiber-scoped context, not module state: two fibers in two
 * transactions never see each other's list.
 */
class Settlements extends Context.Service<Settlements, Array<Effect.Effect<void>>>()(
  "flows/journal/SqlJournal/Settlements"
) {}

const sourceKey = (runId: RunId, sourceId: SourceId): string => `${runId.length}:${runId}${sourceId.length}:${sourceId}`

const sourceEventKey = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `${sourceKey(runId, sourceId)}:${sourceSeq}`

const encodeJson = (value: unknown, field: string): Result.Result<string, JournalError> =>
  Schema.encodeUnknownResult(Schema.UnknownFromJsonString)(value).pipe(
    Result.mapError((cause) => error("invalid_event", `${field} must be JSON-serializable`, cause))
  )

const decodeInput = Schema.decodeUnknownResult(Input)
const decodeEntry = Schema.decodeUnknownEffect(Entry)

const decodeRow = (row: JournalRow): Effect.Effect<Entry, JournalError> =>
  Effect.all({
    payload: Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.payload_json),
    meta: Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(row.meta_json)
  }).pipe(
    Effect.map(({ meta, payload }) => ({
      runId: row.run_id as RunId,
      seq: Number(row.seq),
      eventId: row.event_id,
      sourceId: row.source_id,
      sourceSeq: Number(row.source_seq),
      emittedAtMs: Number(row.emitted_at_ms),
      eventType: row.event_type,
      payload,
      meta
    })),
    Effect.flatMap(decodeEntry),
    Effect.mapError((cause) => error("decode_failed", "could not decode a durable journal row", cause))
  )

interface ValidatedOptions {
  readonly batchSize: number
  readonly sourceEventCache: number
  readonly redact: Redaction.Redactor
}

const validateOptions = (options: SqlJournalOptions): Effect.Effect<ValidatedOptions, JournalError> =>
  Effect.suspend(() => {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      return Effect.fail(error("invalid_event", "capacity must be a positive safe integer"))
    }
    const batchSize = options.batchSize ?? Math.min(options.capacity, 64)
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      return Effect.fail(error("invalid_event", "batchSize must be a positive safe integer"))
    }
    const sourceEventCache = options.sourceEventCache ?? defaultSourceEventCache
    if (!Number.isSafeInteger(sourceEventCache) || sourceEventCache <= 0) {
      return Effect.fail(error("invalid_event", "sourceEventCache must be a positive safe integer"))
    }
    return Effect.succeed({ batchSize, sourceEventCache, redact: options.redact ?? Redaction.make() })
  })

const isJournalError = Schema.is(JournalError)

/**
 * Provides the SQLite-backed journal.
 *
 * `emitLossy` validates and admits telemetry to the non-blocking queue;
 * `emitDurable` allocates and commits inside the database transaction.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: SqlJournalOptions
): Layer.Layer<Journal, JournalError, DurableWriter | SqlClient.SqlClient> =>
  Layer.effect(
    Journal,
    Effect.gen(function*() {
      const { batchSize, redact, sourceEventCache } = yield* validateOptions(options)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const writer = yield* DurableWriter

      const queue = yield* Queue.dropping<QueuedEntry>(options.capacity)
      const changes = yield* PubSub.sliding<Entry>(options.capacity)
      const wakes = new Map<RunId, Set<PubSub.PubSub<void>>>()
      const sequenceRows = yield* sql<SequenceRow>`
        SELECT run_id, MAX(seq) + 1 AS next_seq
        FROM flows_journal_events
        GROUP BY run_id
      `.pipe(
        Effect.mapError((cause) => error("sink_failed", "could not initialize journal sequences", cause))
      )
      const sourceSequenceRows = yield* sql<SourceSequenceRow>`
        SELECT run_id, source_id, MAX(source_seq) + 1 AS next_source_seq
        FROM flows_journal_events
        GROUP BY run_id, source_id
      `.pipe(
        Effect.mapError((cause) => error("sink_failed", "could not initialize journal source sequences", cause))
      )
      /**
       * Only the most recent `sourceEventCache` events are decoded at startup.
       * Older events stay durable-only: their idempotency is enforced by the
       * writer's `(run_id, source_id, source_seq)` re-check, so the process
       * never has to hold the whole history to stay correct.
       */
      const sourceEventRows = yield* sql<JournalRow>`
        SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
          event_type, payload_json, meta_json
        FROM flows_journal_events
        ORDER BY emitted_at_ms DESC, run_id DESC, seq DESC
        LIMIT ${sourceEventCache}
      `.pipe(
        Effect.mapError((cause) => error("sink_failed", "could not initialize journal source events", cause))
      )
      const durableEntries = yield* Effect.forEach(sourceEventRows, decodeRow)
      const initialized = yield* Effect.fromResult(
        Result.gen(function*() {
          const sequences = new Map<RunId, number>()
          for (const row of sequenceRows) {
            const next = Number(row.next_seq)
            if (!Number.isSafeInteger(next) || next < 0) {
              return yield* Result.fail(
                error("decode_failed", "durable sequence is outside the safe integer range")
              )
            }
            sequences.set(row.run_id as RunId, next)
          }
          const sourceSequences = new Map<string, number>()
          for (const row of sourceSequenceRows) {
            const next = Number(row.next_source_seq)
            if (!Number.isSafeInteger(next) || next < 0) {
              return yield* Result.fail(
                error("decode_failed", "durable source sequence is outside the safe integer range")
              )
            }
            sourceSequences.set(
              sourceKey(row.run_id as RunId, row.source_id as SourceId),
              next
            )
          }
          const sourceEvents = new Map<string, SourceEvent>()
          // Seeded oldest-first so the map's insertion order stays the
          // eviction order once `retain` starts adding newer events.
          for (const entry of [...durableEntries].reverse()) {
            if (
              !Number.isSafeInteger(entry.seq) ||
              !Number.isSafeInteger(entry.sourceSeq) ||
              entry.seq === Number.MAX_SAFE_INTEGER ||
              entry.sourceSeq === Number.MAX_SAFE_INTEGER
            ) {
              return yield* Result.fail(
                error("decode_failed", "durable event sequence is outside the allocatable safe integer range")
              )
            }
            sourceEvents.set(sourceEventKey(entry.runId, entry.sourceId, entry.sourceSeq), {
              seq: entry.seq,
              eventType: entry.eventType,
              payloadJson: yield* encodeJson(entry.payload, "payload"),
              metaJson: yield* encodeJson(entry.meta, "meta"),
              status: "committed"
            })
          }
          return {
            sequences,
            sourceSequences,
            sourceEvents
          }
        })
      )
      const state: State = {
        status: "open",
        sinkFailure: undefined,
        lossEpoch: 0,
        flushedLossEpoch: 0,
        pending: 0,
        sequences: initialized.sequences,
        sourceSequences: initialized.sourceSequences,
        sourceEvents: initialized.sourceEvents,
        flushWaiters: new Set()
      }

      /**
       * Adds an entry to the bounded source-event index, evicting the
       * least-recently added *committed* entry when the bound is exceeded.
       *
       * Uncommitted entries are never evicted: they are not in the database
       * yet, so memory is the only place their identity exists. Committed ones
       * are always re-derivable from `flows_journal_events`, which is what
       * makes the bound safe.
       */
      const retain = (identity: string, event: SourceEvent): void => {
        state.sourceEvents.delete(identity)
        state.sourceEvents.set(identity, event)
        if (state.sourceEvents.size <= sourceEventCache) return
        for (const [candidate, retained] of state.sourceEvents) {
          if (retained.status !== "committed" || candidate === identity) continue
          state.sourceEvents.delete(candidate)
          return
        }
      }

      const completeFlushWaiters = (exit: Effect.Effect<void, JournalError>): void => {
        const waiters = Array.from(state.flushWaiters)
        state.flushWaiters.clear()
        for (const waiter of waiters) {
          Deferred.doneUnsafe(waiter, exit)
        }
      }

      const flushInternal: Effect.Effect<void, JournalError> = Effect.suspend(() => {
        // A loss that happened while nothing was registered still has to reach
        // a caller, so the first flush after it reports it — once. A later
        // flush has nothing to do with the lost batch and must succeed, or a
        // single transient outage would stall every durable delivery that
        // flushes (`DeferredPersistence.completeDeferred`, `recordClockScheduled`)
        // for the process's lifetime.
        if (state.sinkFailure !== undefined && state.lossEpoch > state.flushedLossEpoch) {
          state.flushedLossEpoch = state.lossEpoch
          return Effect.fail(state.sinkFailure)
        }
        if (state.status === "closed") {
          return Effect.fail(error("journal_closed", "journal is closed"))
        }
        if (state.pending === 0) {
          return Effect.void
        }
        const waiter = Deferred.makeUnsafe<void, JournalError>()
        state.flushWaiters.add(waiter)
        return Deferred.await(waiter).pipe(
          Effect.ensuring(Effect.sync(() => {
            state.flushWaiters.delete(waiter)
          }))
        )
      })

      const prepare = (input: Input, emittedAtMs: number): Result.Result<Prepared, JournalError> =>
        Result.gen(function*() {
          if (state.status !== "open") {
            return yield* Result.fail(error("journal_closed", "journal is closed"))
          }
          const validated = yield* Result.mapError(
            decodeInput(input),
            (cause) => error("invalid_event", "event violates the journal input contract", cause)
          )
          if (
            validated.runId.length === 0 ||
            validated.sourceId.length === 0 ||
            validated.eventType.length === 0
          ) {
            return yield* Result.fail(
              error("invalid_event", "runId, sourceId, and eventType must not be empty")
            )
          }
          if (!Number.isSafeInteger(emittedAtMs) || emittedAtMs < 0) {
            return yield* Result.fail(
              error("invalid_event", "emittedAtMs must be a non-negative safe integer")
            )
          }
          // Redaction happens here, at the single point every channel funnels
          // through, so no write path can bypass it (issue #46).
          return {
            validated,
            payloadJson: yield* encodeJson(redact(validated.payload), "payload"),
            metaJson: yield* encodeJson(redact(validated.meta ?? null), "meta")
          }
        })

      const queuedEmit: Service["emitLossy"] = Effect.fn("Journal.emitLossy")((input: Input) =>
        Effect.flatMap(Clock.currentTimeMillis, (emittedAtMs) =>
          Effect.suspend(() =>
            Effect.fromResult(
              Result.gen(function*() {
                const { metaJson, payloadJson, validated } = yield* prepare(input, emittedAtMs)
                const key = sourceKey(validated.runId, validated.sourceId)
                const nextSourceSeq = state.sourceSequences.get(key) ?? 0
                const sourceSeq: SourceSeq = validated.sourceSeq ?? (nextSourceSeq as SourceSeq)
                if (
                  !Number.isSafeInteger(sourceSeq) ||
                  sourceSeq < 0 ||
                  sourceSeq === Number.MAX_SAFE_INTEGER
                ) {
                  return yield* Result.fail(
                    error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                  )
                }
                const identity = sourceEventKey(validated.runId, validated.sourceId, sourceSeq)
                const existing = state.sourceEvents.get(identity)
                if (existing !== undefined) {
                  if (
                    existing.eventType !== validated.eventType ||
                    existing.payloadJson !== payloadJson ||
                    existing.metaJson !== metaJson
                  ) {
                    return yield* Result.fail(error(
                      "idempotency_conflict",
                      `source event ${validated.sourceId}:${sourceSeq} for run ${validated.runId} was reused with different content`
                    ))
                  }
                  return {
                    _tag: "Duplicate",
                    seq: existing.seq,
                    sourceSeq,
                    status: existing.status
                  } satisfies EmitReceipt
                }
                const nextSeq = state.sequences.get(validated.runId) ?? 0
                if (
                  !Number.isSafeInteger(nextSeq) ||
                  nextSeq < 0 ||
                  nextSeq === Number.MAX_SAFE_INTEGER
                ) {
                  return yield* Result.fail(
                    error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                  )
                }
                const seq = nextSeq as Seq
                state.sequences.set(validated.runId, nextSeq + 1)
                state.sourceSequences.set(key, Math.max(nextSourceSeq, sourceSeq + 1))

                const queued: QueuedEntry = {
                  runId: validated.runId,
                  seq,
                  eventId: makeEventId(validated.runId, validated.sourceId, sourceSeq),
                  sourceId: validated.sourceId,
                  sourceSeq,
                  emittedAtMs,
                  eventType: validated.eventType,
                  payloadJson,
                  metaJson
                }
                let evicted: QueuedEntry | undefined
                if (Queue.sizeUnsafe(queue) >= options.capacity && options.overflow === "drop-oldest") {
                  const exit = Queue.takeUnsafe(queue)
                  /* v8 ignore next -- size and take run synchronously while the journal and queue are open */
                  if (exit === undefined || !Exit.isSuccess(exit)) {
                    return yield* Result.fail(
                      error("journal_closed", "journal admission queue is unavailable")
                    )
                  }
                  evicted = exit.value
                  const evictedIdentity = sourceEventKey(
                    evicted.runId,
                    evicted.sourceId,
                    evicted.sourceSeq
                  )
                  state.sourceEvents.delete(evictedIdentity)
                  state.pending = Math.max(0, state.pending - 1)
                }
                const accepted = Queue.offerUnsafe(queue, queued)
                if (!accepted) {
                  if (options.overflow === "reject") {
                    return yield* Result.fail(error("queue_overflow", "journal admission queue is full"))
                  }
                  return {
                    _tag: "Dropped",
                    seq,
                    sourceSeq,
                    policy: "drop-newest"
                  } satisfies EmitReceipt
                }

                retain(identity, {
                  seq,
                  eventType: validated.eventType,
                  payloadJson,
                  metaJson,
                  status: "pending"
                })
                state.pending += 1
                if (evicted !== undefined) {
                  return {
                    _tag: "Accepted",
                    seq,
                    sourceSeq,
                    evicted: {
                      policy: "drop-oldest",
                      count: 1
                    }
                  } satisfies EmitReceipt
                }
                return {
                  _tag: "Accepted",
                  seq,
                  sourceSeq
                } satisfies EmitReceipt
              })
            )
          ))
      )

      const readPage: Service["entries"] = Effect.fn("Journal.entries")((pageOptions) =>
        Effect.gen(function*() {
          if (pageOptions.runId.length === 0) {
            return yield* Effect.fail(error("invalid_event", "runId must not be empty"))
          }
          if (!Number.isSafeInteger(pageOptions.limit) || pageOptions.limit <= 0) {
            return yield* Effect.fail(error("invalid_event", "limit must be a positive safe integer"))
          }
          const after = pageOptions.after ?? -1
          if (!Number.isSafeInteger(after) || after < -1) {
            return yield* Effect.fail(error("invalid_event", "after must be a canonical sequence or undefined"))
          }
          const rows = yield* sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE run_id = ${pageOptions.runId} AND seq > ${after}
            ORDER BY seq ASC
            LIMIT ${pageOptions.limit + 1}
          `.pipe(
            Effect.mapError((cause) => error("unknown", "durable journal read failed", cause))
          )
          const page = rows.slice(0, pageOptions.limit)
          const entries = yield* Effect.forEach(page, decodeRow)
          return {
            entries,
            hasMore: rows.length > pageOptions.limit
          } satisfies EntriesPage
        })
      )

      const subscribeRun = (runId: RunId) =>
        Effect.gen(function*() {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const subscribers = wakes.get(runId) ?? new Set()
              subscribers.add(wake)
              wakes.set(runId, subscribers)
            }),
            () =>
              Effect.sync(() => {
                const subscribers = wakes.get(runId)
                subscribers?.delete(wake)
                if (subscribers?.size === 0) {
                  wakes.delete(runId)
                }
              }).pipe(Effect.andThen(PubSub.shutdown(wake)))
          )
          return subscription
        })

      const stream = (streamOptions: StreamOptions): Stream.Stream<Entry, JournalError> =>
        Stream.unwrap(
          Effect.fn("Journal.stream")(function*() {
            const wake = yield* subscribeRun(streamOptions.runId)
            let cursor: number = streamOptions.afterSequence ?? -1
            // A live consumer is told about losses that happen while it is
            // following, and only about those: a loss it never overlapped is
            // already spent by the time it subscribes.
            const subscribedLossEpoch = state.lossEpoch
            const readAvailable: Effect.Effect<ReadonlyArray<Entry>, JournalError> = Effect.suspend(() =>
              state.sinkFailure !== undefined && state.lossEpoch > subscribedLossEpoch
                ? Effect.fail(state.sinkFailure)
                : Effect.gen(function*() {
                  const all: Array<Entry> = []
                  while (true) {
                    const page = yield* readPage({
                      runId: streamOptions.runId,
                      ...(cursor < 0 ? {} : { after: cursor as Seq }),
                      limit: batchSize
                    })
                    all.push(...page.entries)
                    const last = page.entries.at(-1)
                    if (last !== undefined) {
                      cursor = last.seq
                    }
                    if (!page.hasMore) {
                      return all
                    }
                  }
                })
            )
            const historical = yield* readAvailable
            const live = Stream.fromSubscription(wake).pipe(
              Stream.mapEffect(() => readAvailable),
              Stream.flattenIterable
            )
            return Stream.concat(Stream.fromIterable(historical), live)
          })()
        )

      /**
       * Reads the row a duplicate emit collides with.
       *
       * `makeEventId` is a pure, injective function of exactly
       * `(run_id, source_id, source_seq)`, so a second predicate on that triple
       * selected the same row and the `ORDER BY seq ASC LIMIT 1` tiebreak was
       * unreachable. `UNIQUE (event_id)` in the migration is the authority
       * either way, and `JournalEvent`'s test pins the injectivity here rather
       * than paying for it on every insert.
       */
      const selectExisting = (
        queued: QueuedEntry
      ): Effect.Effect<Commit | undefined, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          const existing = yield* sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE event_id = ${queued.eventId}
          `
          if (existing.length === 0) {
            return undefined
          }
          const row = existing[0]!
          if (
            row.event_type !== queued.eventType ||
            row.payload_json !== queued.payloadJson ||
            row.meta_json !== queued.metaJson
          ) {
            return yield* Effect.fail(
              error(
                "idempotency_conflict",
                `source event ${queued.sourceId}:${queued.sourceSeq} for run ${queued.runId} was reused with different content`
              )
            )
          }
          return {
            entry: yield* decodeRow(row),
            inserted: false
          }
        })

      /**
       * When `owner` is present the insert is fenced on the run's persisted
       * ownership with the same `WHERE EXISTS` predicate
       * `DurableEngineState.scheduleClock` uses, following Temporal's shard
       * `rangeID` check (`service/history/shard/context_impl.go`,
       * `renewRangeLocked`) reduced to one SQL predicate: a zombie owner whose
       * run was reclaimed cannot append, and fails with `fence_lost`.
       */
      const insertOne = (
        queued: QueuedEntry,
        owner?: OwnerId
      ): Effect.Effect<Commit, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          const duplicate = yield* selectExisting(queued)
          if (duplicate !== undefined) {
            return duplicate
          }
          const insert = owner === undefined
            ? sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${queued.runId},
                ${queued.seq},
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
            : sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              )
              SELECT
                ${queued.runId},
                ${queued.seq},
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              WHERE EXISTS (
                SELECT 1
                FROM flows_runs
                WHERE run_id = ${queued.runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
          const inserted = yield* insert
          if (inserted.length > 0) {
            return {
              entry: yield* decodeRow(inserted[0]!),
              inserted: true
            }
          }
          const racedDuplicate = yield* selectExisting(queued)
          if (racedDuplicate !== undefined) {
            return racedDuplicate
          }
          return yield* Effect.fail(
            owner === undefined
              ? error(
                "sequence_conflict",
                `sequence ${queued.seq} for run ${queued.runId} was committed by another writer`
              )
              : error(
                "fence_lost",
                `run ${queued.runId} is no longer owned by ${owner.hostId}:${owner.pid}:${owner.nonce}`
              )
          )
        })

      const persistBatch = (
        batch: ReadonlyArray<QueuedEntry>
      ): Effect.Effect<ReadonlyArray<Commit>, JournalError> =>
        writer.write(Effect.forEach(batch, (queued) => insertOne(queued))).pipe(
          Effect.mapError((cause) =>
            isJournalError(cause)
              ? cause
              : error("sink_failed", "journal sink failed", cause)
          )
        )

      const publish = (commits: ReadonlyArray<Commit>): Effect.Effect<void> =>
        Effect.forEach(
          commits,
          (commit) => {
            if (!commit.inserted) {
              return Effect.void
            }
            return PubSub.publish(changes, commit.entry).pipe(
              Effect.andThen(
                Effect.forEach(
                  wakes.get(commit.entry.runId) ?? [],
                  (wake) => PubSub.publish(wake, undefined),
                  { discard: true }
                )
              ),
              Effect.asVoid
            )
          },
          { discard: true }
        )

      const rememberCommitted = (queued: QueuedEntry, seq: Seq): void => {
        retain(sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq), {
          seq,
          eventType: queued.eventType,
          payloadJson: queued.payloadJson,
          metaJson: queued.metaJson,
          status: "committed"
        })
        state.sequences.set(queued.runId, Math.max(state.sequences.get(queued.runId) ?? 0, seq + 1))
        const key = sourceKey(queued.runId, queued.sourceId)
        state.sourceSequences.set(key, Math.max(state.sourceSequences.get(key) ?? 0, queued.sourceSeq + 1))
      }

      /**
       * Reads the durable allocation floor for a run (or a producer) inside the
       * caller's transaction.
       *
       * Stated deviation from smithers `packages/db/src/adapter.js`, which
       * allocates `MAX(seq) + 1` under `BEGIN IMMEDIATE`: Effect's SQL client
       * has no `beginTransaction` hook on the SQLite backends we ship
       * (`@effect/sql-sqlite-node` never forwards one), so `DurableWriter.write`
       * runs the default DEFERRED transaction. The read therefore takes a
       * shared lock and the later INSERT upgrades it. Under WAL — enabled by
       * `NodeDatabase` — a concurrent writer makes that upgrade fail with
       * `SQLITE_BUSY_SNAPSHOT`, which `WriteRetry.isRetryableSqliteWriteError`
       * classifies as retryable, so the whole transaction (floor read
       * included) replays against the committed snapshot. Allocation is
       * conflict-free by retry rather than by lock escalation; the invariant
       * is proved by
       * `packages/journal/test/JournalDurable.test.ts` ("emitDurable never
       * collides when two connections write one run concurrently").
       *
       * Governing design: `docs/specs/Concepts/Journal Queue.md`.
       */
      const nextDurable = (
        column: "seq" | "source_seq",
        runId: RunId,
        sourceId: SourceId | undefined
      ): Effect.Effect<number, SqlError.SqlError> =>
        Effect.map(
          column === "seq"
            ? sql<{ readonly next: number | null }>`
              SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${runId}
            `
            : sql<{ readonly next: number | null }>`
              SELECT MAX(source_seq) + 1 AS next FROM flows_journal_events
              WHERE run_id = ${runId} AND source_id = ${sourceId!}
            `,
          (rows) => Number(rows[0]?.next ?? 0)
        )

      /**
       * Records a committed entry in the in-process index and publishes it —
       * immediately outside a transaction, parked on the enclosing
       * {@link Settlements} list inside one.
       */
      const settleCommit = (queued: QueuedEntry, commit: Commit): Effect.Effect<void> =>
        Effect.flatMap(Effect.serviceOption(Settlements), (enclosing) => {
          const settlement = Effect.sync(() => rememberCommitted(queued, commit.entry.seq)).pipe(
            Effect.andThen(publish([commit]))
          )
          return Option.isNone(enclosing)
            ? settlement
            : Effect.sync(() => {
              enclosing.value.push(settlement)
            })
        })

      /**
       * Opens (or joins) the write transaction that keeps the logical WAL
       * atomic with the executable state it describes.
       *
       * The transaction body is re-entered verbatim when `DurableWriter.write`
       * replays a transient conflict, so the settlement list is reset on each
       * attempt: an abandoned attempt's entries were rolled back with it and
       * must never be published or indexed.
       */
      const transact: Service["transact"] = <A, E, R>(
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | JournalError, R> =>
        Effect.flatMap(Effect.serviceOption(Settlements), (enclosing) => {
          const write = <A2, E2, R2>(body: Effect.Effect<A2, E2, R2>) =>
            writer.write(body).pipe(
              Effect.catchIf(
                (cause): cause is DatabaseError => cause instanceof DatabaseError,
                (cause) => Effect.fail(error("sink_failed", "journal transaction failed", cause))
              )
            )
          // A nested transact is a savepoint of the enclosing one; the
          // outermost owner of the list publishes for all of them.
          if (Option.isSome(enclosing)) {
            return write(effect)
          }
          const settlements: Array<Effect.Effect<void>> = []
          return write(
            Effect.suspend(() => {
              settlements.length = 0
              return Effect.provideService(effect, Settlements, settlements)
            })
          ).pipe(
            Effect.tap(() => Effect.forEach(settlements, (settlement) => settlement, { discard: true }))
          )
        })

      const emitDurable: Service["emitDurable"] = Effect.fn("Journal.emitDurable")((
        input: Input,
        owner?: OwnerId
      ) =>
        Effect.flatMap(Clock.currentTimeMillis, (emittedAtMs) =>
          Effect.flatMap(Effect.fromResult(prepare(input, emittedAtMs)), ({ metaJson, payloadJson, validated }) =>
            writer.write(
              Effect.gen(function*() {
                const key = sourceKey(validated.runId, validated.sourceId)
                const sourceSeq: SourceSeq = validated.sourceSeq ??
                  (Math.max(
                    yield* nextDurable("source_seq", validated.runId, validated.sourceId),
                    state.sourceSequences.get(key) ?? 0
                  ) as SourceSeq)
                if (
                  !Number.isSafeInteger(sourceSeq) ||
                  sourceSeq < 0 ||
                  sourceSeq === Number.MAX_SAFE_INTEGER
                ) {
                  return yield* Effect.fail(
                    error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                  )
                }
                const seq = Math.max(
                  yield* nextDurable("seq", validated.runId, undefined),
                  state.sequences.get(validated.runId) ?? 0
                ) as Seq
                if (!Number.isSafeInteger(seq) || seq === Number.MAX_SAFE_INTEGER) {
                  return yield* Effect.fail(
                    error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                  )
                }
                const queued: QueuedEntry = {
                  runId: validated.runId,
                  seq,
                  eventId: makeEventId(validated.runId, validated.sourceId, sourceSeq),
                  sourceId: validated.sourceId,
                  sourceSeq,
                  emittedAtMs,
                  eventType: validated.eventType,
                  payloadJson,
                  metaJson
                }
                const commit = yield* insertOne(queued, owner)
                return { commit, queued, sourceSeq }
              })
            ).pipe(
              /**
               * `writer.write` is a retrying transaction: its body replays on
               * `SQLITE_BUSY(_SNAPSHOT)` and can still abort at COMMIT after the
               * body succeeded. Cache mutation and publication therefore happen
               * strictly after the transaction returns, so subscribers never
               * observe a rolled-back entry and a replayed body never publishes
               * twice. Mirrors the queued path, which publishes in a `.tap`
               * outside `persistBatch`.
               *
               * Under `transact` "after the transaction returns" is not yet
               * "after COMMIT" — this write is a savepoint of the caller's
               * transaction — so `settle` parks both effects until the
               * outermost transaction commits.
               */
              Effect.tap(({ commit, queued }) =>
                settleCommit(queued, commit)
              ),
              Effect.map(({ commit, sourceSeq }) =>
                commit.inserted
                  ? { _tag: "Accepted", seq: commit.entry.seq, sourceSeq } as const
                  : { _tag: "Duplicate", seq: commit.entry.seq, sourceSeq, status: "committed" } as const
              ),
              Effect.mapError((cause) =>
                isJournalError(cause) ? cause : error("sink_failed", "durable journal write failed", cause)
              )
            )))
      )

      const emitLossy: Service["emitLossy"] = queuedEmit

      const recordCommits = (
        batch: ReadonlyArray<QueuedEntry>,
        commits: ReadonlyArray<Commit>
      ): void => {
        for (let index = 0; index < commits.length; index++) {
          const queued = batch[index]!
          const commit = commits[index]!
          retain(
            sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq),
            {
              seq: commit.entry.seq,
              eventType: queued.eventType,
              payloadJson: queued.payloadJson,
              metaJson: queued.metaJson,
              status: "committed"
            }
          )
        }
      }

      const settle = (count: number): void => {
        state.pending = Math.max(0, state.pending - count)
        if (state.pending === 0) {
          completeFlushWaiters(Effect.void)
        }
      }

      // `lost` is the size of the batch this failure destroyed. The writer
      // survives a failed batch, so only that batch leaves the pending set;
      // entries queued behind it are still undrained and a later flush must
      // keep waiting for them rather than vouch for unpersisted work.
      const failSink = (cause: JournalError, lost: number): void => {
        state.sinkFailure = cause
        state.lossEpoch += 1
        state.pending = Math.max(0, state.pending - lost)
        // A waiter that is already registered is the flush the loss belongs
        // to, so reporting it there spends the report; only a loss nobody was
        // waiting on is left for the next flush to pick up.
        if (state.flushWaiters.size > 0) {
          state.flushedLossEpoch = state.lossEpoch
        }
        completeFlushWaiters(Effect.fail(cause))
        for (const subscribers of wakes.values()) {
          for (const wake of subscribers) {
            PubSub.publishUnsafe(wake, undefined)
          }
        }
      }

      // One failed batch loses that batch and is reported as such; it never
      // ends the writer. Only interruption (scope closure) stops the loop, so
      // the queue keeps draining as soon as the database is healthy again.
      const writeBatch = Queue.takeBetween(queue, 1, batchSize).pipe(
        Effect.flatMap((batch) =>
          persistBatch(batch).pipe(
            Effect.tap((commits) =>
              Effect.sync(() =>
                recordCommits(batch, commits)
              )
            ),
            Effect.tap(publish),
            Effect.tap(() => Effect.sync(() => settle(batch.length))),
            Effect.catch((cause) => Effect.sync(() => failSink(cause, batch.length))),
            // Defects only: an interruption is scope closure, and it must end
            // the writer rather than be reported as a lost batch.
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                failSink(
                  error("sink_failed", "journal writer failed", Cause.die(defect)),
                  batch.length
                )
              )
            )
          )
        )
      )

      const drain = Effect.forever(writeBatch)

      yield* Effect.forkScoped(drain)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          // A scope finalizer runs once, and nothing else moves the status, so
          // the journal is always `open` here.
          yield* Effect.sync(() => {
            state.status = "closing"
          })
          yield* Effect.ignore(flushInternal)
          yield* Effect.sync(() => {
            state.status = "closed"
          })
          yield* Queue.shutdown(queue)
          yield* PubSub.shutdown(changes)
          wakes.clear()
        })
      )

      const project = <S, E, R>(
        projection: Projection<S, E, R>,
        streamOptions: StreamOptions
      ): Stream.Stream<S, JournalError, R> =>
        Stream.unwrap(
          Effect.fn("Journal.project")(
            <S2, E2, R2>(
              activeProjection: Projection<S2, E2, R2>,
              activeOptions: StreamOptions
            ) =>
              Effect.succeed(
                stream(activeOptions).pipe(
                  Stream.scanEffect(activeProjection.initial, (state, entry) =>
                    Effect.suspend(() => activeProjection.reduce(state, entry)).pipe(
                      Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Effect.failCause(cause as Cause.Cause<never>)
                          : Effect.fail(
                            error(
                              "projection_failed",
                              `projection ${activeProjection.name} failed`,
                              cause
                            )
                          )
                      )
                    ))
                )
              )
          )(projection, streamOptions)
        )

      return makeJournal({
        emitLossy,
        emitDurable,
        transact,
        stream,
        entries: readPage,
        changes: PubSub.subscribe(changes),
        project,
        flush: Effect.fn("Journal.flush")(() => flushInternal)()
      })
    })
  )
