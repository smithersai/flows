/**
 * Durable deferred-completion and clock-deadline state used by the flow
 * engine adapter.
 *
 * The waiting-reason taxonomy (one `waiting` status plus
 * `reason`/`wakeAt`/`token`, migration 0004) is specified by
 * [[Run Ownership]] (`docs/specs/Concepts/Run Ownership.md`) and recorded in
 * [[Engine Hardening Round 1]]
 * (`docs/specs/Concepts/Engine Hardening Round 1.md`), section 5.
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
 * The core wait-reason vocabulary a supervisor understands for wake policy.
 *
 * Left open (`string & {}`) so a plugin can park on a reason the core
 * taxonomy has not named yet — the store persists whatever it is given
 * rather than rejecting unknown reasons.
 *
 * @since 0.1.0
 * @category models
 */
export type WaitingReason = "approval" | "event" | "timer" | "quota" | (string & {})

/**
 * The payload recorded when a run parks.
 *
 * `reason` and `wakeAt` earn columns because a supervisor sweeper queries
 * them (`WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <= ?`);
 * `token` is compare-and-swap/lookup material a wake handler matches
 * against.
 *
 * @since 0.1.0
 * @category models
 */
export interface Waiting {
  readonly reason: WaitingReason
  readonly wakeAt?: number
  readonly token?: string
}

/**
 * A decoded waiting row for a parked run.
 *
 * @since 0.1.0
 * @category models
 */
export interface WaitingRow {
  readonly runId: string
  readonly reason: WaitingReason
  readonly wakeAt: number | null
  readonly token: string | null
}

/**
 * A predicate over `waitingRuns` — omitted fields are unconstrained.
 *
 * @since 0.1.0
 * @category models
 */
export interface WaitingRunsFilter {
  readonly reason?: string
  readonly dueBeforeMs?: number
}

/**
 * Result of recording that a run parked on a waiting reason.
 *
 * @since 0.1.0
 * @category models
 */
export type ParkOutcome =
  | { readonly _tag: "Parked"; readonly row: WaitingRow }
  | { readonly _tag: "NotFound" }

/**
 * Result of clearing a run's waiting payload on wake.
 *
 * @since 0.1.0
 * @category models
 */
export type WakeOutcome =
  | { readonly _tag: "Woken"; readonly row: WaitingRow }
  | { readonly _tag: "NotWaiting" }
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
   */
  readonly completedDeferreds: (
    flowName: string
  ) => Effect.Effect<ReadonlyArray<DeferredAddress>>
  /**
   * Records the waiting-reason payload for a parked run, fenced to the
   * current owner so a stale process cannot park a run it no longer runs.
   */
  readonly park: (
    runId: string,
    waiting: Waiting,
    owner: OwnerId
  ) => Effect.Effect<ParkOutcome>
  /**
   * Clears a run's waiting payload on wake or resume. Idempotent: waking a
   * run that is not waiting reports `NotWaiting` rather than failing.
   */
  readonly wake: (runId: string) => Effect.Effect<WakeOutcome>
  /**
   * Reads the current waiting payload for a run, if any.
   */
  readonly waiting: (runId: string) => Effect.Effect<Option.Option<WaitingRow>>
  /**
   * Lists parked runs matching an optional reason/due-before filter, ordered
   * for sweeper consumption (earliest wake first).
   */
  readonly waitingRuns: (
    filter?: WaitingRunsFilter
  ) => Effect.Effect<ReadonlyArray<WaitingRow>>
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

const WaitingDatabaseRow = Schema.Struct({
  runId: Schema.String,
  waitingReason: Schema.String,
  waitingWakeAtMs: Schema.NullOr(NonNegativeSafeInt),
  waitingToken: Schema.NullOr(Schema.String)
})

type WaitingDatabaseRow = typeof WaitingDatabaseRow.Type

const decodeWaitingRow = (input: unknown): Effect.Effect<WaitingRow> =>
  Schema.decodeUnknownEffect(WaitingDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.map((row) => ({
      runId: row.runId,
      reason: row.waitingReason,
      wakeAt: row.waitingWakeAtMs,
      token: row.waitingToken
    }))
  )

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

  const completedDeferreds: Service["completedDeferreds"] = Effect.fn(
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

  const selectWaiting = (runId: string) =>
    sql<WaitingDatabaseRow>`
      SELECT
        run_id AS "runId",
        waiting_reason AS "waitingReason",
        waiting_wake_at_ms AS "waitingWakeAtMs",
        waiting_token AS "waitingToken"
      FROM flows_runs
      WHERE run_id = ${runId}
        AND waiting_reason IS NOT NULL
    `

  const park: Service["park"] = Effect.fn("DurableEngineState.park")((runId, waiting, owner) =>
    database.write(
      Effect.gen(function*() {
        const updated = yield* sql<WaitingDatabaseRow>`
          UPDATE flows_runs
          SET
            waiting_reason = ${waiting.reason},
            waiting_wake_at_ms = ${waiting.wakeAt ?? null},
            waiting_token = ${waiting.token ?? null}
          WHERE run_id = ${runId}
            AND owner_host_id = ${owner.hostId}
            AND owner_pid = ${owner.pid}
            AND owner_nonce = ${owner.nonce}
          RETURNING
            run_id AS "runId",
            waiting_reason AS "waitingReason",
            waiting_wake_at_ms AS "waitingWakeAtMs",
            waiting_token AS "waitingToken"
        `
        if (updated[0] === undefined) {
          return { _tag: "NotFound" as const }
        }
        return { _tag: "Parked" as const, row: yield* decodeWaitingRow(updated[0]) }
      })
    ).pipe(Effect.orDie)
  )

  const wake: Service["wake"] = Effect.fn("DurableEngineState.wake")((runId) =>
    database.write(
      Effect.gen(function*() {
        const before = yield* selectWaiting(runId)
        if (before[0] === undefined) {
          const existing = yield* sql<{ runId: string }>`
            SELECT run_id AS "runId" FROM flows_runs WHERE run_id = ${runId}
          `
          return existing[0] === undefined ? { _tag: "NotFound" as const } : { _tag: "NotWaiting" as const }
        }
        const row = yield* decodeWaitingRow(before[0])
        yield* sql`
          UPDATE flows_runs
          SET
            waiting_reason = NULL,
            waiting_wake_at_ms = NULL,
            waiting_token = NULL
          WHERE run_id = ${runId}
            AND waiting_reason IS NOT NULL
        `
        return { _tag: "Woken" as const, row }
      })
    ).pipe(Effect.orDie)
  )

  const waiting: Service["waiting"] = Effect.fn("DurableEngineState.waiting")((runId) =>
    selectWaiting(runId).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeWaitingRow(rows[0]), Option.some)
      )
    )
  )

  const waitingRuns: Service["waitingRuns"] = Effect.fn("DurableEngineState.waitingRuns")((filter) =>
    (filter?.reason !== undefined && filter.dueBeforeMs !== undefined
      ? sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason = ${filter.reason}
          AND waiting_wake_at_ms IS NOT NULL
          AND waiting_wake_at_ms <= ${filter.dueBeforeMs}
        ORDER BY waiting_wake_at_ms, run_id
      `
      : filter?.reason !== undefined
      ? sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason = ${filter.reason}
        ORDER BY waiting_wake_at_ms, run_id
      `
      : filter?.dueBeforeMs !== undefined
      ? sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason IS NOT NULL
          AND waiting_wake_at_ms IS NOT NULL
          AND waiting_wake_at_ms <= ${filter.dueBeforeMs}
        ORDER BY waiting_wake_at_ms, run_id
      `
      : sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason IS NOT NULL
        ORDER BY waiting_wake_at_ms, run_id
      `).pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, decodeWaitingRow))
      )
  )

  return DurableEngineState.of({
    deferred,
    completeDeferred,
    clock,
    scheduleClock,
    completeClock,
    dueClocks,
    completedDeferreds,
    park,
    wake,
    waiting,
    waitingRuns
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
 * A run's ownership view as the in-memory implementation needs it for the
 * same fences the SQL implementation reads from `flows_runs`.
 *
 * @since 0.1.0
 * @category models
 */
export interface MemoryRunView {
  readonly status: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled"
  readonly owner: OwnerId | null
}

/**
 * Options for the in-memory durable-state implementation.
 *
 * @since 0.1.0
 * @category models
 */
export interface MemoryOptions {
  /**
   * Resolves a run's existence, status, and owner — the in-memory analogue
   * of the `flows_runs` lookups the SQL implementation performs for its
   * `park`/`wake`/`scheduleClock` fences. `Option.none()` means the run does
   * not exist. When omitted, every run is treated as running and owned by
   * whichever owner is presented (the permissive legacy shape for tests
   * that exercise only deferred/clock state without a run table).
   */
  readonly runs?: (runId: string) => Option.Option<MemoryRunView>
}

/**
 * Constructs a deterministic in-memory durable-state implementation.
 *
 * The returned service can be shared by multiple fresh engine instances in a
 * test to model process restart over the same storage. With `runs` supplied
 * it enforces the same ownership fences as the SQL implementation and is
 * held to the same contract suite
 * (`test/contract/DurableEngineStateContract.ts`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeMemory = (options: MemoryOptions = {}): Service => {
  const deferreds = new Map<string, DeferredRow>()
  const clocks = new Map<string, ClockRow>()
  const waitingRows = new Map<string, WaitingRow>()

  const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
    left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

  /** Mirrors the SQL `flows_runs` owner-match predicate for a run. */
  const runView = (runId: string, presented: OwnerId | undefined): {
    readonly exists: boolean
    readonly running: boolean
    readonly owned: boolean
  } => {
    if (options.runs === undefined) {
      return { exists: true, running: true, owned: true }
    }
    const view = options.runs(runId)
    if (Option.isNone(view)) {
      return { exists: false, running: false, owned: false }
    }
    const owned = presented !== undefined &&
      view.value.owner !== null &&
      sameOwner(view.value.owner, presented)
    return { exists: true, running: view.value.status === "running", owned }
  }

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
    scheduleClock: Effect.fn("DurableEngineState.scheduleClock")((row, owner) =>
      Effect.suspend(() => {
        // Mirrors the SQL fence: creation requires the presented owner to
        // currently run the execution; a lost fence surfaces as
        // self-interruption, an existing row wins regardless.
        if (owner === undefined) return Effect.interrupt
        const key = clockKey(row)
        const existing = clocks.get(key)
        if (existing !== undefined) {
          return Effect.succeed({ _tag: "Existing" as const, row: existing })
        }
        const view = runView(row.executionId, owner)
        if (!view.exists || !view.running || !view.owned) {
          return Effect.interrupt
        }
        clocks.set(key, row)
        return Effect.succeed({ _tag: "Scheduled" as const, row })
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
    ),
    park: Effect.fn("DurableEngineState.park")((runId, waitingPayload, owner) =>
      Effect.sync(() => {
        // Mirrors the SQL fence: only the current owner of an existing run
        // may park it; anything else reports NotFound, exactly like the
        // owner-guarded UPDATE matching no row.
        const view = runView(runId, owner)
        if (!view.exists || !view.owned) {
          return { _tag: "NotFound" as const }
        }
        const row: WaitingRow = {
          runId,
          reason: waitingPayload.reason,
          wakeAt: waitingPayload.wakeAt ?? null,
          token: waitingPayload.token ?? null
        }
        waitingRows.set(runId, row)
        return { _tag: "Parked" as const, row }
      })
    ),
    wake: Effect.fn("DurableEngineState.wake")((runId) =>
      Effect.sync(() => {
        const row = waitingRows.get(runId)
        if (row === undefined) {
          // Mirrors SQL: an unknown run is NotFound, an existing unparked
          // run is NotWaiting.
          return runView(runId, undefined).exists
            ? { _tag: "NotWaiting" as const }
            : { _tag: "NotFound" as const }
        }
        waitingRows.delete(runId)
        return { _tag: "Woken" as const, row }
      })
    ),
    waiting: Effect.fn("DurableEngineState.waiting")((runId) =>
      Effect.sync(() => Option.fromNullishOr(waitingRows.get(runId)))
    ),
    waitingRuns: Effect.fn("DurableEngineState.waitingRuns")((filter) =>
      Effect.sync(() =>
        Array.from(waitingRows.values())
          .filter((row) => filter?.reason === undefined || row.reason === filter.reason)
          .filter((row) =>
            filter?.dueBeforeMs === undefined ||
            (row.wakeAt !== null && row.wakeAt <= filter.dueBeforeMs)
          )
          .sort((left, right) =>
            (left.wakeAt ?? Number.MAX_SAFE_INTEGER) - (right.wakeAt ?? Number.MAX_SAFE_INTEGER) ||
            left.runId.localeCompare(right.runId)
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
