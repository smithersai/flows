/**
 * The deferred/clock journal fold.
 *
 * Design: `docs/specs/Concepts/Deferred Clock Fold.md`, stage 2 of
 * `docs/specs/Concepts/Journal Consensus.md`. The invariant: at every commit,
 * `flows_deferred_completions` and `flows_clock_deadlines` equal the fold of
 * the journal. Forward progress appends the record and updates the row as
 * savepoints of one `DurableWriter` transaction
 * (`internal/DeferredPersistence.ts`); this module is the other direction —
 * the reducers that recompute the tables from the journal, and
 * {@link rebuild}, which truncates and repopulates both tables inside one
 * write transaction. There is no third way to write these tables.
 *
 * The tables stay as the engine's wakeup indexes — `dueClocks`,
 * `pendingClocks`, and `completedDeferreds` are sweeper queries that must not
 * replay a journal per tick — but they are demoted from contract to cache:
 * this module is what makes the demotion honest.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Journal, Projection } from "@smthrs/journal"
import type { JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as DurableEngineState from "./DurableEngineState.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/** @private */
const NonNegativeSafeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The exact fold-input event types, inside the existing `flows.engine.*`
 * namespace by design: `@smthrs/engine-store` already appended the first two
 * under it and renaming them would break their replay/time-travel consumers
 * for no contractual gain. A projection selects these types; the rest of
 * `flows.engine.*` carries attempt, node, cache, and selection records that
 * are not inputs to these tables.
 *
 * @since 0.1.0
 * @category constants
 */
export const eventTypes = {
  deferredCompleted: "flows.engine.deferred-completed",
  deferredSnapshot: "flows.engine.deferred-snapshot",
  clockScheduled: "flows.engine.clock-scheduled",
  clockCompleted: "flows.engine.clock-completed",
  clockSnapshot: "flows.engine.clock-snapshot"
} as const

/**
 * The fold-state key of a deferred address.
 *
 * @since 0.1.0
 * @category constructors
 */
export const deferredKey = (address: DurableEngineState.DeferredAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.deferredName])

/**
 * The fold-state key of a clock address.
 *
 * @since 0.1.0
 * @category constructors
 */
export const clockKey = (address: DurableEngineState.ClockAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.clockName])

/**
 * A self-contained deferred fold input: the full row, `completedAtMs`
 * included. A `deferred-completed` record without `completedAtMs` predates
 * the fold — its exit may have passed through the write-path redactor — and
 * fails this decode, which is how the reducer skips it; the migration's
 * snapshot record carries that row instead.
 */
const DeferredInputPayload = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString,
  exit: Schema.Unknown,
  metadata: Schema.optionalKey(Schema.Unknown),
  completedAtMs: NonNegativeSafeInt
})

/** The identity a schedule record carries; the row it seeds is pending. */
const ClockScheduledPayload = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  clockName: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt
})

/** The completion a `clock-completed` record carries. */
const ClockCompletedPayload = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  clockName: Schema.NonEmptyString,
  completedAtMs: NonNegativeSafeInt
})

/** A full clock row, as the administrative snapshot record carries it. */
const ClockSnapshotPayload = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  clockName: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

/**
 * The deferred fold state: one row per address, keyed by
 * {@link deferredKey}.
 *
 * @since 0.1.0
 * @category models
 */
export type DeferredFoldState = ReadonlyMap<string, DurableEngineState.DeferredRow>

/**
 * The clock fold state: one row per address, keyed by {@link clockKey}.
 *
 * @since 0.1.0
 * @category models
 */
export type ClockFoldState = ReadonlyMap<string, DurableEngineState.ClockRow>

const reduceDeferred = (state: DeferredFoldState, entry: JournalEvent.Entry): DeferredFoldState => {
  if (
    entry.eventType !== eventTypes.deferredCompleted &&
    entry.eventType !== eventTypes.deferredSnapshot
  ) {
    return state
  }
  const decoded = Schema.decodeUnknownResult(DeferredInputPayload)(entry.payload)
  // Not self-contained: a pre-fold record, not a fold input.
  if (Result.isFailure(decoded)) return state
  const payload = decoded.success
  const row: DurableEngineState.DeferredRow = {
    flowName: payload.flowName,
    executionId: payload.executionId,
    deferredName: payload.deferredName,
    exit: payload.exit,
    ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    completedAtMs: payload.completedAtMs
  }
  const key = deferredKey(row)
  // First event per address wins — the first-completion-wins rule itself.
  if (state.has(key)) return state
  return new Map(state).set(key, row)
}

const reduceClock = (state: ClockFoldState, entry: JournalEvent.Entry): ClockFoldState => {
  switch (entry.eventType) {
    case eventTypes.clockScheduled: {
      const decoded = Schema.decodeUnknownResult(ClockScheduledPayload)(entry.payload)
      if (Result.isFailure(decoded)) return state
      const payload = decoded.success
      const key = clockKey(payload)
      // First event per address wins; the registration sweep's
      // re-announcement of a pending clock folds to nothing.
      if (state.has(key)) return state
      return new Map(state).set(key, {
        flowName: payload.flowName,
        executionId: payload.executionId,
        clockName: payload.clockName,
        deferredName: payload.deferredName,
        dueAtMs: payload.dueAtMs,
        completedAtMs: null
      })
    }
    case eventTypes.clockCompleted: {
      const decoded = Schema.decodeUnknownResult(ClockCompletedPayload)(entry.payload)
      if (Result.isFailure(decoded)) return state
      const payload = decoded.success
      const key = clockKey(payload)
      const existing = state.get(key)
      // First completion per address wins; a completion for an address the
      // fold has not seen has no row to complete.
      if (existing === undefined || existing.completedAtMs !== null) return state
      return new Map(state).set(key, { ...existing, completedAtMs: payload.completedAtMs })
    }
    case eventTypes.clockSnapshot: {
      const decoded = Schema.decodeUnknownResult(ClockSnapshotPayload)(entry.payload)
      if (Result.isFailure(decoded)) return state
      const payload = decoded.success
      const key = clockKey(payload)
      const existing = state.get(key)
      if (existing === undefined) {
        return new Map(state).set(key, {
          flowName: payload.flowName,
          executionId: payload.executionId,
          clockName: payload.clockName,
          deferredName: payload.deferredName,
          dueAtMs: payload.dueAtMs,
          completedAtMs: payload.completedAtMs
        })
      }
      // A snapshot may carry the one fact no ordinary record holds — the
      // completion of a pre-fold fired clock, whose CAS predates the
      // `clock-completed` record — so it also completes a pending folded
      // row rather than resurrecting the deadline.
      if (existing.completedAtMs === null && payload.completedAtMs !== null) {
        return new Map(state).set(key, { ...existing, completedAtMs: payload.completedAtMs })
      }
      return state
    }
    default:
      return state
  }
}

/**
 * The `flows_deferred_completions` reducer: a reproducible fold of one run's
 * committed entries into that run's deferred rows.
 *
 * @since 0.1.0
 * @category projections
 */
export const deferredProjection: Projection.Projection<DeferredFoldState> = Projection.make<DeferredFoldState>({
  name: "@smthrs/engine-store/Fold/deferred",
  initial: new Map(),
  reduce: (state, entry) => Effect.succeed(reduceDeferred(state, entry))
})

/**
 * The `flows_clock_deadlines` reducer: a reproducible fold of one run's
 * committed entries into that run's clock rows.
 *
 * @since 0.1.0
 * @category projections
 */
export const clockProjection: Projection.Projection<ClockFoldState> = Projection.make<ClockFoldState>({
  name: "@smthrs/engine-store/Fold/clock",
  initial: new Map(),
  reduce: (state, entry) => Effect.succeed(reduceClock(state, entry))
})

/**
 * Row counts of one completed rebuild.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rebuilt {
  readonly deferreds: number
  readonly clocks: number
}

const encodeJson = (value: unknown, field: string): Effect.Effect<string> =>
  Schema.encodeEffect(UnknownFromJsonString)(value).pipe(
    /* v8 ignore next 2 -- fold rows are decoded from committed payload_json, and a JSON-decoded value always re-encodes; the mapping keeps the defect legible for a corrupted journal */
    Effect.mapError((cause) => new Error(`${field} must be JSON-serializable`, { cause })),
    Effect.orDie
  )

/** How many committed entries one rebuild page reads. */
const pageSize = 64

/**
 * Truncates `flows_deferred_completions` and `flows_clock_deadlines` and
 * repopulates both from the journal, inside one `DurableWriter` transaction.
 *
 * This is the operation that makes the tables' demotion to wakeup indexes
 * honest: recovery keeps reading the tables, and `rebuild` proves they were
 * only ever a cache of the journal. It schedules nothing itself — it
 * restores the index the next registration or sweep reads, which is exactly
 * the restart behavior the sweep already implements.
 *
 * @since 0.1.0
 * @category operations
 */
export const rebuild: Effect.Effect<
  Rebuilt,
  never,
  DurableWriter | Journal.Journal | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  const journal = yield* Journal.Journal
  return yield* writer.write(
    Effect.gen(function*() {
      const runs = yield* sql<{ readonly runId: string }>`
        SELECT DISTINCT run_id AS "runId"
        FROM flows_journal_events
        WHERE event_type IN (
          ${eventTypes.deferredCompleted},
          ${eventTypes.deferredSnapshot},
          ${eventTypes.clockScheduled},
          ${eventTypes.clockCompleted},
          ${eventTypes.clockSnapshot}
        )
        ORDER BY run_id
      `
      const deferredRows: Array<DurableEngineState.DeferredRow> = []
      const clockRows: Array<DurableEngineState.ClockRow> = []
      for (const run of runs) {
        let deferredState = deferredProjection.initial
        let clockState = clockProjection.initial
        let after: JournalEvent.Seq | undefined = undefined
        for (;;) {
          const page: Journal.EntriesPage = yield* journal.entries({
            runId: run.runId as JournalEvent.RunId,
            ...(after === undefined ? {} : { after }),
            limit: pageSize
          })
          for (const entry of page.entries) {
            deferredState = yield* deferredProjection.reduce(deferredState, entry)
            clockState = yield* clockProjection.reduce(clockState, entry)
          }
          if (!page.hasMore) break
          after = page.entries.at(-1)!.seq
        }
        deferredRows.push(...deferredState.values())
        clockRows.push(...clockState.values())
      }
      yield* sql`DELETE FROM flows_deferred_completions`
      yield* sql`DELETE FROM flows_clock_deadlines`
      for (const row of deferredRows) {
        const exitJson = yield* encodeJson(row.exit, "exit")
        const metadataJson = row.metadata === undefined
          ? null
          : yield* encodeJson(row.metadata, "metadata")
        yield* sql`
          INSERT INTO flows_deferred_completions (
            flow_name,
            execution_id,
            deferred_name,
            exit_json,
            metadata_json,
            completed_at_ms
          ) VALUES (
            ${row.flowName},
            ${row.executionId},
            ${row.deferredName},
            ${exitJson},
            ${metadataJson},
            ${row.completedAtMs}
          )
        `
      }
      for (const row of clockRows) {
        yield* sql`
          INSERT INTO flows_clock_deadlines (
            flow_name,
            execution_id,
            clock_name,
            deferred_name,
            due_at_ms,
            completed_at_ms
          ) VALUES (
            ${row.flowName},
            ${row.executionId},
            ${row.clockName},
            ${row.deferredName},
            ${row.dueAtMs},
            ${row.completedAtMs}
          )
        `
      }
      return { deferreds: deferredRows.length, clocks: clockRows.length }
    })
  ).pipe(Effect.orDie)
})
