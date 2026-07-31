/**
 * Durable deferred-completion and clock-deadline state used by the flow
 * engine adapter.
 *
 * @since 0.1.0
 */
import { Database } from "@smithers/database/Database"
import type { OwnerId } from "@smithers/journal/Ownership"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The durable address of a deferred result.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeferredAddress {
  readonly flowName: string
  readonly executionId: string
  readonly deferredName: string
}

/**
 * The first durable completion recorded for a deferred.
 *
 * Correlation data remains opaque at this boundary. A future external-event
 * layer owns its schema and authorization policy.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeferredRow extends DeferredAddress {
  readonly exit: unknown
  readonly metadata?: unknown
  readonly completedAtMs: number
}

/**
 * Result of a first-writer-wins deferred completion.
 *
 * @since 0.1.0
 * @category models
 */
export type CompleteDeferredOutcome =
  | { readonly _tag: "Completed"; readonly row: DeferredRow }
  | { readonly _tag: "Existing"; readonly row: DeferredRow }

/**
 * The durable address of a clock.
 *
 * @since 0.1.0
 * @category models
 */
export interface ClockAddress {
  readonly flowName: string
  readonly executionId: string
  readonly clockName: string
}

/**
 * A durable absolute clock deadline.
 *
 * @since 0.1.0
 * @category models
 */
export interface ClockRow extends ClockAddress {
  readonly deferredName: string
  readonly dueAtMs: number
  readonly completedAtMs: number | null
}

/**
 * Result of scheduling a durable clock.
 *
 * @since 0.1.0
 * @category models
 */
export type ScheduleClockOutcome =
  | { readonly _tag: "Scheduled"; readonly row: ClockRow }
  | { readonly _tag: "Existing"; readonly row: ClockRow }

/**
 * Result of completing a durable clock.
 *
 * @since 0.1.0
 * @category models
 */
export type CompleteClockOutcome =
  | { readonly _tag: "Completed"; readonly row: ClockRow }
  | { readonly _tag: "AlreadyCompleted"; readonly row: ClockRow }
  | { readonly _tag: "NotFound" }

/**
 * Minimal durable state missing from the current `@smithers/journal` contract.
 *
 * A successful mutation means the row is durable. Callers may therefore
 * journal and schedule a wake only after the mutation returns.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  // TODO(piece-6): fold into @smithers/journal — needs DeferredStore.get(flowName, executionId, deferredName).
  readonly deferred: (address: DeferredAddress) => Effect.Effect<Option.Option<DeferredRow>>
  // TODO(piece-6): fold into @smithers/journal — needs DeferredStore.completeFirstWriterWins(row).
  readonly completeDeferred: (row: DeferredRow) => Effect.Effect<CompleteDeferredOutcome>
  // TODO(piece-6): fold into @smithers/journal — needs ClockStore.get(flowName, executionId, clockName).
  readonly clock: (address: ClockAddress) => Effect.Effect<Option.Option<ClockRow>>
  // TODO(piece-6): fold into @smithers/journal — needs ClockStore.scheduleFirstWriterWins(rowWithAbsoluteDueAtMs).
  readonly scheduleClock: (row: ClockRow, owner?: OwnerId) => Effect.Effect<ScheduleClockOutcome>
  // TODO(piece-6): fold into @smithers/journal — needs ClockStore.completeOnce(address, completedAtMs).
  readonly completeClock: (
    address: ClockAddress,
    completedAtMs: number
  ) => Effect.Effect<CompleteClockOutcome>
  // TODO(piece-6): fold into @smithers/journal — needs ClockStore.due(nowMs).
  readonly dueClocks: (nowMs: number) => Effect.Effect<ReadonlyArray<ClockRow>>
  /**
   * Lists completed deferred addresses for registration-time wake recovery.
   *
   * Optional so existing custom implementations remain source-compatible.
   */
  readonly completedDeferreds?: (
    flowName: string
  ) => Effect.Effect<ReadonlyArray<DeferredAddress>>
}

/**
 * Service tag for durable deferred completions and absolute clock deadlines.
 *
 * @since 0.1.0
 * @category services
 */
export class DurableEngineState extends Context.Service<DurableEngineState, Service>()(
  "flows/engine-store/DurableEngineState"
) {}

const deferredKey = (address: DeferredAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.deferredName])

const clockKey = (address: ClockAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.clockName])

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const DeferredDatabaseRow = Schema.Struct({
  flowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String,
  exitJson: Schema.String,
  metadataJson: Schema.NullOr(Schema.String),
  completedAtMs: NonNegativeSafeInt
})

type DeferredDatabaseRow = typeof DeferredDatabaseRow.Type

const ClockDatabaseRow = Schema.Struct({
  flowName: Schema.String,
  executionId: Schema.String,
  clockName: Schema.String,
  deferredName: Schema.String,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

type ClockDatabaseRow = typeof ClockDatabaseRow.Type

const DeferredAddressDatabaseRow = Schema.Struct({
  flowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String
})

const encodeJson = (value: unknown, field: string): Effect.Effect<string> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new Error(`${field} must be JSON-serializable`, { cause })
  }).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      encoded === undefined
        ? Effect.die(new Error(`${field} must be JSON-serializable`))
        : Effect.succeed(encoded)
    )
  )

const decodeJson = (value: string, field: string): Effect.Effect<unknown> =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => new Error(`could not decode ${field}`, { cause })
  }).pipe(Effect.orDie)

const decodeDeferredRow = (input: unknown): Effect.Effect<DeferredRow> =>
  Schema.decodeUnknownEffect(DeferredDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.flatMap((row) =>
      Effect.all({
        exit: decodeJson(row.exitJson, "exit_json"),
        metadata: row.metadataJson === null
          ? Effect.succeed(undefined)
          : decodeJson(row.metadataJson, "metadata_json")
      }).pipe(
        Effect.map(({ exit, metadata }) => ({
          flowName: row.flowName,
          executionId: row.executionId,
          deferredName: row.deferredName,
          exit,
          ...(metadata === undefined ? {} : { metadata }),
          completedAtMs: row.completedAtMs
        }))
      )
    )
  )

const decodeClockRow = (input: unknown): Effect.Effect<ClockRow> =>
  Schema.decodeUnknownEffect(ClockDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.map((row) => ({
      flowName: row.flowName,
      executionId: row.executionId,
      clockName: row.clockName,
      deferredName: row.deferredName,
      dueAtMs: row.dueAtMs,
      completedAtMs: row.completedAtMs
    }))
  )

/**
 * Constructs the database-backed durable-state implementation.
 *
 * Clock creation is fenced against the current run owner. Deferred completion
 * and clock firing are external trigger admissions protected by first-writer
 * and compare-and-set semantics; execution remains claim-gated by `RunStore`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, Database> = Effect.gen(function*() {
  const database = yield* Database
  const { sql } = database

  const selectDeferred = (address: DeferredAddress) =>
    sql<DeferredDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        deferred_name AS "deferredName",
        exit_json AS "exitJson",
        metadata_json AS "metadataJson",
        completed_at_ms AS "completedAtMs"
      FROM flows_deferred_completions
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND deferred_name = ${address.deferredName}
    `

  const selectClock = (address: ClockAddress) =>
    sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND clock_name = ${address.clockName}
    `

  const deferred: Service["deferred"] = Effect.fn("DurableEngineState.deferred")((address) =>
    selectDeferred(address).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeDeferredRow(rows[0]), Option.some)
      )
    )
  )

  const completeDeferred: Service["completeDeferred"] = Effect.fn(
    "DurableEngineState.completeDeferred"
  )((row) =>
    Effect.gen(function*() {
      const exitJson = yield* encodeJson(row.exit, "exit")
      const metadataJson = row.metadata === undefined
        ? null
        : yield* encodeJson(row.metadata, "metadata")
      return yield* database.write(
        Effect.gen(function*() {
          const inserted = yield* sql<DeferredDatabaseRow>`
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
            ON CONFLICT (flow_name, execution_id, deferred_name) DO NOTHING
            RETURNING
              flow_name AS "flowName",
              execution_id AS "executionId",
              deferred_name AS "deferredName",
              exit_json AS "exitJson",
              metadata_json AS "metadataJson",
              completed_at_ms AS "completedAtMs"
          `
          if (inserted[0] !== undefined) {
            return {
              _tag: "Completed" as const,
              row: yield* decodeDeferredRow(inserted[0])
            }
          }
          const existing = yield* selectDeferred(row)
          if (existing[0] === undefined) {
            return yield* Effect.die(
              new Error("deferred completion disappeared during first-writer transaction")
            )
          }
          return {
            _tag: "Existing" as const,
            row: yield* decodeDeferredRow(existing[0])
          }
        })
      ).pipe(Effect.orDie)
    })
  )

  const clock: Service["clock"] = Effect.fn("DurableEngineState.clock")((address) =>
    selectClock(address).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeClockRow(rows[0]), Option.some)
      )
    )
  )

  const scheduleClock: Service["scheduleClock"] = Effect.fn("DurableEngineState.scheduleClock")((row, owner) =>
    owner === undefined
      ? Effect.interrupt
      : database.write(
        Effect.gen(function*() {
          const inserted = yield* sql<ClockDatabaseRow>`
            INSERT INTO flows_clock_deadlines (
              flow_name,
              execution_id,
              clock_name,
              deferred_name,
              due_at_ms,
              completed_at_ms
            )
            SELECT
              ${row.flowName},
              ${row.executionId},
              ${row.clockName},
              ${row.deferredName},
              ${row.dueAtMs},
              ${row.completedAtMs}
            WHERE EXISTS (
              SELECT 1
              FROM flows_runs
              WHERE run_id = ${row.executionId}
                AND status = 'running'
                AND owner_host_id = ${owner.hostId}
                AND owner_pid = ${owner.pid}
                AND owner_nonce = ${owner.nonce}
            )
            ON CONFLICT (flow_name, execution_id, clock_name) DO NOTHING
            RETURNING
              flow_name AS "flowName",
              execution_id AS "executionId",
              clock_name AS "clockName",
              deferred_name AS "deferredName",
              due_at_ms AS "dueAtMs",
              completed_at_ms AS "completedAtMs"
          `
          if (inserted[0] !== undefined) {
            return {
              _tag: "Scheduled" as const,
              row: yield* decodeClockRow(inserted[0])
            }
          }
          const existing = yield* selectClock(row)
          if (existing[0] !== undefined) {
            return {
              _tag: "Existing" as const,
              row: yield* decodeClockRow(existing[0])
            }
          }
          return yield* Effect.interrupt
        })
      ).pipe(Effect.orDie)
  )

  const completeClock: Service["completeClock"] = Effect.fn("DurableEngineState.completeClock")((
    address,
    completedAtMs
  ) =>
    database.write(
      Effect.gen(function*() {
        const updated = yield* sql<ClockDatabaseRow>`
          UPDATE flows_clock_deadlines
          SET completed_at_ms = ${completedAtMs}
          WHERE flow_name = ${address.flowName}
            AND execution_id = ${address.executionId}
            AND clock_name = ${address.clockName}
            AND completed_at_ms IS NULL
          RETURNING
            flow_name AS "flowName",
            execution_id AS "executionId",
            clock_name AS "clockName",
            deferred_name AS "deferredName",
            due_at_ms AS "dueAtMs",
            completed_at_ms AS "completedAtMs"
        `
        if (updated[0] !== undefined) {
          return {
            _tag: "Completed" as const,
            row: yield* decodeClockRow(updated[0])
          }
        }
        const existing = yield* selectClock(address)
        return existing[0] === undefined
          ? { _tag: "NotFound" as const }
          : {
            _tag: "AlreadyCompleted" as const,
            row: yield* decodeClockRow(existing[0])
          }
      })
    ).pipe(Effect.orDie)
  )

  const dueClocks: Service["dueClocks"] = Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
    sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND due_at_ms <= ${nowMs}
      ORDER BY due_at_ms, execution_id, clock_name
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => Effect.forEach(rows, decodeClockRow))
    )
  )

  const completedDeferreds: NonNullable<Service["completedDeferreds"]> = Effect.fn(
    "DurableEngineState.completedDeferreds"
  )((flowName) =>
    sql<Record<string, unknown>>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        deferred_name AS "deferredName"
      FROM flows_deferred_completions
      WHERE flow_name = ${flowName}
      ORDER BY execution_id, deferred_name
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => Schema.decodeUnknownEffect(DeferredAddressDatabaseRow)(row).pipe(Effect.orDie)
        )
      )
    )
  )

  return DurableEngineState.of({
    deferred,
    completeDeferred,
    clock,
    scheduleClock,
    completeClock,
    dueClocks,
    completedDeferreds
  })
})

/**
 * Provides database-backed durable engine state.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<DurableEngineState, never, Database> = Layer.effect(
  DurableEngineState,
  make
)

/**
 * Constructs a deterministic in-memory durable-state implementation.
 *
 * The returned service can be shared by multiple fresh engine instances in a
 * test to model process restart over the same storage.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeMemory = (): Service => {
  const deferreds = new Map<string, DeferredRow>()
  const clocks = new Map<string, ClockRow>()

  return DurableEngineState.of({
    deferred: Effect.fn("DurableEngineState.deferred")((address) =>
      Effect.sync(() => Option.fromNullishOr(deferreds.get(deferredKey(address))))
    ),
    completeDeferred: Effect.fn("DurableEngineState.completeDeferred")((row) =>
      Effect.sync(() => {
        const key = deferredKey(row)
        const existing = deferreds.get(key)
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: existing }
        }
        deferreds.set(key, row)
        return { _tag: "Completed" as const, row }
      })
    ),
    clock: Effect.fn("DurableEngineState.clock")((address) =>
      Effect.sync(() => Option.fromNullishOr(clocks.get(clockKey(address))))
    ),
    scheduleClock: Effect.fn("DurableEngineState.scheduleClock")((row) =>
      Effect.sync(() => {
        const key = clockKey(row)
        const existing = clocks.get(key)
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: existing }
        }
        clocks.set(key, row)
        return { _tag: "Scheduled" as const, row }
      })
    ),
    completeClock: Effect.fn("DurableEngineState.completeClock")((address, completedAtMs) =>
      Effect.sync(() => {
        const key = clockKey(address)
        const existing = clocks.get(key)
        if (existing === undefined) {
          return { _tag: "NotFound" as const }
        }
        if (existing.completedAtMs !== null) {
          return { _tag: "AlreadyCompleted" as const, row: existing }
        }
        const row = { ...existing, completedAtMs }
        clocks.set(key, row)
        return { _tag: "Completed" as const, row }
      })
    ),
    dueClocks: Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
      Effect.sync(() =>
        Array.from(clocks.values())
          .filter((row) => row.completedAtMs === null && row.dueAtMs <= nowMs)
          .sort((left, right) =>
            left.dueAtMs - right.dueAtMs ||
            left.executionId.localeCompare(right.executionId) ||
            left.clockName.localeCompare(right.clockName)
          )
      )
    ),
    completedDeferreds: Effect.fn("DurableEngineState.completedDeferreds")((flowName) =>
      Effect.sync(() =>
        Array.from(deferreds.values())
          .filter((row) => row.flowName === flowName)
          .map(({ flowName, executionId, deferredName }) => ({
            flowName,
            executionId,
            deferredName
          }))
          .sort((left, right) =>
            left.executionId.localeCompare(right.executionId) ||
            left.deferredName.localeCompare(right.deferredName)
          )
      )
    )
  })
}

/**
 * Provides deterministic in-memory durable engine state.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemory: Layer.Layer<DurableEngineState> = Layer.sync(
  DurableEngineState,
  makeMemory
)
