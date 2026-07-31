/**
 * Durable deferred delivery and absolute clock scheduling.
 *
 * @since 0.1.0
 */
import { type DurableClock, type DurableDeferred, type Flow, FlowEngine } from "@smithers/engine"
import { Journal, type Ownership } from "@smithers/journal"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberMap from "effect/FiberMap"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as JournalRecords from "./JournalRecords.ts"

/**
 * Reasons passed to the single claim-gated resume scheduler.
 *
 * @since 0.1.0
 * @category models
 */
export type ResumeReason = "deferred" | "clock"

/**
 * Dependencies for durable deferred and clock persistence.
 *
 * `scheduleResume` must enter the run coordinator and ownership claim path. It
 * must never invoke a flow handler directly.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly owner: Ownership.OwnerId
  readonly journalSource: string
  readonly scheduleResume: (
    flowName: string,
    executionId: string,
    reason: ResumeReason
  ) => Effect.Effect<void>
}

/**
 * Encoded deferred completion with optional opaque correlation metadata.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeferredDoneOptions {
  readonly flowName: string
  readonly executionId: string
  readonly deferredName: string
  readonly exit: Exit.Exit<unknown, unknown>
  readonly metadata?: unknown
}

/**
 * Durable deferred and clock operations composed into the encoded engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly deferredResult: (
    deferred: DurableDeferred.Any
  ) => Effect.Effect<
    Option.Option<Exit.Exit<unknown, unknown>>,
    never,
    FlowEngine.FlowInstance
  >
  readonly deferredDone: (options: DeferredDoneOptions) => Effect.Effect<void>
  readonly scheduleClock: (
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock.DurableClock
    }
  ) => Effect.Effect<void>
  readonly sweepDue: (flowName?: string) => Effect.Effect<void>
}

const clockKey = (row: DurableEngineState.ClockAddress): string =>
  JSON.stringify([row.flowName, row.executionId, row.clockName])

/**
 * Redispatch policy for a durable clock whose fire failed.
 *
 * Temporal redispatches timer-queue tasks with backoff until they are acked
 * (`reference/temporal` `service/history` timer queue + `common/backoff`); we
 * mirror that here so one transient journal/flush error at fire time cannot
 * lose the timer until a process restart. Exponential from 100ms, capped at
 * 30s, forever — the fire is idempotent (first-writer deferred completion,
 * deduplicated journal admission, CAS clock completion), so retrying an
 * arbitrary prefix is safe.
 */
const fireRetryPolicy = Schedule.min([
  Schedule.exponential("100 millis"),
  Schedule.spaced("30 seconds")
])

/**
 * Constructs durable deferred and clock persistence.
 *
 * Delivery ordering is `durable state -> durable journal -> claim-gated
 * resume`. The delivery operation itself never invokes a flow handler.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  dependencies: Dependencies
): Effect.Effect<
  Service,
  never,
  DurableEngineState.DurableEngineState | Journal.Journal | Scope.Scope
> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const journal = yield* Journal.Journal
    const timers = yield* FiberMap.make<string>()

    const completeDeferred = (
      options: DeferredDoneOptions,
      reason: ResumeReason = "deferred"
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const completedAtMs = yield* Clock.currentTimeMillis
        const completion = yield* state.completeDeferred({
          flowName: options.flowName,
          executionId: options.executionId,
          deferredName: options.deferredName,
          exit: options.exit,
          ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
          completedAtMs
        })
        const row = completion.row

        const receipt = yield* journal.emit(
          JournalRecords.deferredCompleted({
            runId: options.executionId,
            sourceId: `${dependencies.journalSource}:deferred:${
              JSON.stringify([options.flowName, options.executionId, options.deferredName])
            }`,
            sourceSeq: 0
          }, {
            flowName: row.flowName,
            executionId: row.executionId,
            deferredName: row.deferredName,
            exit: row.exit,
            ...(row.metadata === undefined ? {} : { metadata: row.metadata })
          })
        ).pipe(Effect.orDie)
        if (receipt._tag === "Dropped") {
          return yield* Effect.die(
            new Error(
              `durable deferred journal admission was dropped for ${options.executionId}/${options.deferredName}`
            )
          )
        }
        yield* journal.flush.pipe(Effect.orDie)
        yield* dependencies.scheduleResume(
          row.flowName,
          row.executionId,
          reason
        )
      })

    const fireClock = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      Effect.gen(function*() {
        const completedAtMs = yield* Clock.currentTimeMillis
        yield* completeDeferred(
          {
            flowName: row.flowName,
            executionId: row.executionId,
            deferredName: row.deferredName,
            exit: Exit.void,
            metadata: {
              clockName: row.clockName,
              dueAtMs: row.dueAtMs,
              completedAtMs
            }
          },
          "clock"
        )
        yield* state.completeClock(row, completedAtMs)
      })

    const armClock = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          fireClock(row).pipe(
            // A failed fire (journal emit/flush defect included) must not kill
            // the one-shot timer fiber: expose the full cause and redispatch
            // with backoff until the fire is durably acked.
            Effect.sandbox,
            Effect.retry(fireRetryPolicy),
            Effect.orDie,
            Effect.delay(Duration.millis(Math.max(0, row.dueAtMs - nowMs))),
            FiberMap.run(timers, clockKey(row), { onlyIfMissing: true })
          )
        ),
        Effect.asVoid
      )

    const recordClockScheduled = (
      row: DurableEngineState.ClockRow
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const receipt = yield* journal.emit(
          JournalRecords.clockScheduled({
            runId: row.executionId,
            sourceId: `${dependencies.journalSource}:clock:${
              JSON.stringify([row.flowName, row.executionId, row.clockName])
            }`,
            sourceSeq: 0
          }, {
            flowName: row.flowName,
            executionId: row.executionId,
            clockName: row.clockName,
            deferredName: row.deferredName,
            dueAtMs: row.dueAtMs
          })
        ).pipe(Effect.orDie)
        if (receipt._tag === "Dropped") {
          return yield* Effect.die(
            new Error(`durable clock journal admission was dropped for ${row.executionId}/${row.clockName}`)
          )
        }
        yield* journal.flush.pipe(Effect.orDie)
      })

    const scheduleClock: Service["scheduleClock"] = Effect.fn("DeferredPersistence.scheduleClock")((
      flow,
      options
    ) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis
        const scheduled = yield* state.scheduleClock({
          flowName: flow._tag,
          executionId: options.executionId,
          clockName: options.clock.name,
          deferredName: options.clock.deferred.name,
          dueAtMs: nowMs + Duration.toMillis(options.clock.duration),
          completedAtMs: null
        }, dependencies.owner)
        yield* recordClockScheduled(scheduled.row)
        yield* armClock(scheduled.row)
      })
    )

    const sweepDue: Service["sweepDue"] = Effect.fn("DeferredPersistence.sweepDue")((flowName) =>
      Effect.gen(function*() {
        const rows = yield* state.dueClocks(Number.MAX_SAFE_INTEGER)
        yield* Effect.forEach(
          flowName === undefined
            ? rows
            : rows.filter((row) => row.flowName === flowName),
          (row) => recordClockScheduled(row).pipe(Effect.andThen(armClock(row))),
          { discard: true }
        )
        if (flowName !== undefined) {
          const completions = yield* state.completedDeferreds(flowName)
          yield* Effect.forEach(
            completions,
            (address) =>
              dependencies.scheduleResume(
                address.flowName,
                address.executionId,
                "deferred"
              ),
            { discard: true }
          )
        }
      })
    )

    return {
      deferredResult: Effect.fn("DeferredPersistence.deferredResult")(function*(deferred) {
        const instance = yield* FlowEngine.FlowInstance
        const row = yield* state.deferred({
          flowName: instance.flow._tag,
          executionId: instance.executionId,
          deferredName: deferred.name
        })
        return Option.map(row, (value) => value.exit as Exit.Exit<unknown, unknown>)
      }),
      deferredDone: Effect.fn("DeferredPersistence.deferredDone")(completeDeferred),
      scheduleClock,
      sweepDue
    }
  })
