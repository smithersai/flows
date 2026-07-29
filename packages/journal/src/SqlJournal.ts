/**
 * SQLite-backed non-blocking journal.
 *
 * Accepted events remain optimistic until the single scoped writer commits
 * them. A process crash can therefore lose accepted-but-unwritten events.
 *
 * Governing design: `docs/specs/Concepts/Journal Queue.md`.
 * Prior-art decision: `docs/specs/Research/Sync Decision 2026-07-28.md`.
 *
 * The replay-then-follow stream follows Effect `EventJournal` and opencode
 * `packages/core/src/event.ts`. The bounded send queue deliberately deviates
 * from their synchronous durable writes by allocating the canonical per-run
 * sequence before admission. SQLite retry and transaction behavior comes
 * through `@flows/database`.
 *
 * @since 0.1.0
 */
import { Database } from "@flows/database/Database"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SqlError from "effect/unstable/sql/SqlError"
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
import type { Projection } from "./Projection.ts"

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
}

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

type Status = "open" | "closing" | "closed" | "failed"

interface State {
  status: Status
  failure: JournalError | undefined
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

const sourceKey = (runId: RunId, sourceId: SourceId): string => `${runId.length}:${runId}${sourceId.length}:${sourceId}`

const sourceEventKey = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `${sourceKey(runId, sourceId)}:${sourceSeq}`

const encodeJson = (value: unknown, field: string): Result.Result<string, JournalError> =>
  Result.try({
    try: () => JSON.stringify(value),
    catch: (cause) => error("invalid_event", `${field} must be JSON-serializable`, cause)
  }).pipe(
    Result.flatMap((encoded) =>
      encoded === undefined
        ? Result.fail(error("invalid_event", `${field} must be JSON-serializable`))
        : Result.succeed(encoded)
    )
  )

const decodeInput = Schema.decodeUnknownResult(Input)
const decodeEntry = Schema.decodeUnknownEffect(Entry)

const decodeRow = (row: JournalRow): Effect.Effect<Entry, JournalError> =>
  Effect.try({
    try: () => ({
      runId: row.run_id as RunId,
      seq: Number(row.seq),
      eventId: row.event_id,
      sourceId: row.source_id,
      sourceSeq: Number(row.source_seq),
      emittedAtMs: Number(row.emitted_at_ms),
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as unknown,
      meta: JSON.parse(row.meta_json) as unknown
    }),
    catch: (cause) => error("decode_failed", "could not decode a durable journal row", cause)
  }).pipe(
    Effect.flatMap(decodeEntry),
    Effect.mapError((cause) =>
      cause instanceof JournalError
        ? cause
        : error("decode_failed", "could not decode a durable journal row", cause)
    )
  )

const validateOptions = (options: SqlJournalOptions): Effect.Effect<number, JournalError> =>
  Effect.suspend(() => {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      return Effect.fail(error("invalid_event", "capacity must be a positive safe integer"))
    }
    const batchSize = options.batchSize ?? Math.min(options.capacity, 64)
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      return Effect.fail(error("invalid_event", "batchSize must be a positive safe integer"))
    }
    return Effect.succeed(batchSize)
  })

const isJournalError = Schema.is(JournalError)

/**
 * Provides the SQLite-backed journal.
 *
 * `emit` performs validation, canonical per-run sequence allocation, producer
 * sequence allocation, and unsafe non-blocking queue admission in one
 * synchronous section. The scoped writer persists the already-assigned
 * sequence without reordering it.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: SqlJournalOptions): Layer.Layer<Journal, JournalError, Database> =>
  Layer.effect(
    Journal,
    Effect.gen(function*() {
      const batchSize = yield* validateOptions(options)
      const database = yield* Database
      const sql = database.sql
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
      const sourceEventRows = yield* sql<JournalRow>`
        SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
          event_type, payload_json, meta_json
        FROM flows_journal_events
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
          for (const entry of durableEntries) {
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
        failure: undefined,
        pending: 0,
        sequences: initialized.sequences,
        sourceSequences: initialized.sourceSequences,
        sourceEvents: initialized.sourceEvents,
        flushWaiters: new Set()
      }

      const completeFlushWaiters = (exit: Effect.Effect<void, JournalError>): void => {
        const waiters = Array.from(state.flushWaiters)
        state.flushWaiters.clear()
        for (const waiter of waiters) {
          Deferred.doneUnsafe(waiter, exit)
        }
      }

      const flushInternal: Effect.Effect<void, JournalError> = Effect.suspend(() => {
        if (state.status === "failed") {
          return Effect.fail(state.failure!)
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

      const emit: Service["emit"] = Effect.fn("Journal.emit")((input: Input) =>
        Effect.flatMap(Clock.currentTimeMillis, (emittedAtMs) =>
          Effect.suspend(() =>
            Effect.fromResult(
              Result.gen(function*() {
                if (state.status === "failed") {
                  return yield* Result.fail(state.failure!)
                }
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

                const payloadJson = yield* encodeJson(validated.payload, "payload")
                const metaJson = yield* encodeJson(validated.meta ?? null, "meta")
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

                state.sourceEvents.set(identity, {
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
            const readAvailable: Effect.Effect<ReadonlyArray<Entry>, JournalError> = Effect.suspend(() =>
              state.status === "failed"
                ? Effect.fail(state.failure!)
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

      const selectExisting = (
        queued: QueuedEntry
      ): Effect.Effect<Commit | undefined, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          const existing = yield* sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE event_id = ${queued.eventId}
              OR (
                run_id = ${queued.runId}
                AND source_id = ${queued.sourceId}
                AND source_seq = ${queued.sourceSeq}
              )
            ORDER BY seq ASC
            LIMIT 1
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

      const insertOne = (
        queued: QueuedEntry
      ): Effect.Effect<Commit, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          const duplicate = yield* selectExisting(queued)
          if (duplicate !== undefined) {
            return duplicate
          }
          const inserted = yield* sql<JournalRow>`
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
            error(
              "sequence_conflict",
              `sequence ${queued.seq} for run ${queued.runId} was committed by another writer`
            )
          )
        })

      const persistBatch = (
        batch: ReadonlyArray<QueuedEntry>
      ): Effect.Effect<ReadonlyArray<Commit>, JournalError> =>
        database.write(Effect.forEach(batch, insertOne)).pipe(
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

      const recordCommits = (
        batch: ReadonlyArray<QueuedEntry>,
        commits: ReadonlyArray<Commit>
      ): void => {
        for (let index = 0; index < commits.length; index++) {
          const queued = batch[index]!
          const commit = commits[index]!
          state.sourceEvents.set(
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

      const failSink = (cause: JournalError): void => {
        state.status = "failed"
        state.failure = cause
        state.pending = 0
        completeFlushWaiters(Effect.fail(cause))
        for (const subscribers of wakes.values()) {
          for (const wake of subscribers) {
            PubSub.publishUnsafe(wake, undefined)
          }
        }
      }

      const writer = Effect.forever(
        Queue.takeBetween(queue, 1, batchSize).pipe(
          Effect.flatMap((batch) =>
            persistBatch(batch).pipe(
              Effect.tap((commits) => Effect.sync(() => recordCommits(batch, commits))),
              Effect.tap(publish),
              Effect.tap(() => Effect.sync(() => settle(batch.length)))
            )
          )
        )
      ).pipe(
        Effect.catch((cause) => Effect.sync(() => failSink(cause))),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => failSink(error("sink_failed", "journal writer failed", cause)))
        )
      )

      yield* Effect.forkScoped(writer)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          const shouldDrain = yield* Effect.sync(() => {
            if (state.status !== "open") {
              return state.status === "closing"
            }
            state.status = "closing"
            return true
          })
          if (shouldDrain) {
            yield* Effect.ignore(flushInternal)
          }
          yield* Effect.sync(() => {
            if (state.status !== "failed") {
              state.status = "closed"
            }
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
        emit,
        stream,
        entries: readPage,
        changes: PubSub.subscribe(changes),
        project,
        flush: Effect.fn("Journal.flush")(() => flushInternal)()
      })
    })
  )
