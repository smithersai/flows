/**
 * Durable deferred delivery and absolute clock scheduling.
 *
 * @since 0.1.0
 */
import { Journal } from "@flows/journal"
import { type DurableClock, type DurableDeferred, type Workflow, WorkflowEngine } from "@flows/workflow-engine"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberMap from "effect/FiberMap"
import * as Option from "effect/Option"
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
 * must never invoke a workflow handler directly.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly journalSource: string
  readonly scheduleResume: (
    workflowName: string,
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
  readonly workflowName: string
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
    WorkflowEngine.WorkflowInstance
  >
  readonly deferredDone: (options: DeferredDoneOptions) => Effect.Effect<void>
  readonly scheduleClock: (
    workflow: Workflow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock.DurableClock
    }
  ) => Effect.Effect<void>
  readonly sweepDue: (workflowName?: string) => Effect.Effect<void>
}

const clockKey = (row: DurableEngineState.ClockAddress): string =>
  JSON.stringify([row.workflowName, row.executionId, row.clockName])

/**
 * Constructs durable deferred and clock persistence.
 *
 * Delivery ordering is `durable state -> durable journal -> claim-gated
 * resume`. The delivery operation itself never invokes a workflow handler.
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
          workflowName: options.workflowName,
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
              JSON.stringify([options.workflowName, options.executionId, options.deferredName])
            }`,
            sourceSeq: 0
          }, {
            workflowName: row.workflowName,
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
        if (completion._tag === "Completed" || receipt._tag === "Accepted") {
          yield* dependencies.scheduleResume(
            row.workflowName,
            row.executionId,
            reason
          )
        }
      })

    const fireClock = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      Effect.gen(function*() {
        const completedAtMs = yield* Clock.currentTimeMillis
        const completion = yield* state.completeClock(row, completedAtMs)
        if (completion._tag === "NotFound") return
        yield* completeDeferred(
          {
            workflowName: row.workflowName,
            executionId: row.executionId,
            deferredName: row.deferredName,
            exit: Exit.void,
            metadata: {
              clockName: row.clockName,
              dueAtMs: row.dueAtMs,
              completedAtMs: completion.row.completedAtMs
            }
          },
          "clock"
        )
      })

    const armClock = (row: DurableEngineState.ClockRow): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          fireClock(row).pipe(
            Effect.delay(Duration.millis(Math.max(0, row.dueAtMs - nowMs))),
            FiberMap.run(timers, clockKey(row), { onlyIfMissing: true })
          )
        ),
        Effect.asVoid
      )

    const scheduleClock: Service["scheduleClock"] = Effect.fn("DeferredPersistence.scheduleClock")((
      workflow,
      options
    ) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis
        const scheduled = yield* state.scheduleClock({
          workflowName: workflow._tag,
          executionId: options.executionId,
          clockName: options.clock.name,
          deferredName: options.clock.deferred.name,
          dueAtMs: nowMs + Duration.toMillis(options.clock.duration),
          completedAtMs: null
        })
        const receipt = yield* journal.emit(
          JournalRecords.clockScheduled({
            runId: options.executionId,
            sourceId: `${dependencies.journalSource}:clock:${
              JSON.stringify([workflow._tag, options.executionId, options.clock.name])
            }`,
            sourceSeq: 0
          }, {
            workflowName: scheduled.row.workflowName,
            executionId: scheduled.row.executionId,
            clockName: scheduled.row.clockName,
            deferredName: scheduled.row.deferredName,
            dueAtMs: scheduled.row.dueAtMs
          })
        ).pipe(Effect.orDie)
        if (receipt._tag === "Dropped") {
          return yield* Effect.die(
            new Error(`durable clock journal admission was dropped for ${options.executionId}/${options.clock.name}`)
          )
        }
        yield* journal.flush.pipe(Effect.orDie)
        yield* armClock(scheduled.row)
      })
    )

    const sweepDue: Service["sweepDue"] = Effect.fn("DeferredPersistence.sweepDue")((workflowName) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap(state.dueClocks),
        Effect.flatMap((rows) =>
          Effect.forEach(
            workflowName === undefined
              ? rows
              : rows.filter((row) => row.workflowName === workflowName),
            fireClock,
            { discard: true }
          )
        )
      )
    )

    return {
      deferredResult: Effect.fn("DeferredPersistence.deferredResult")(function*(deferred) {
        const instance = yield* WorkflowEngine.WorkflowInstance
        const row = yield* state.deferred({
          workflowName: instance.workflow._tag,
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
