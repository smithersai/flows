/**
 * Durable timers for workflow sleeps.
 *
 * `make` creates a `DurableClock` with a name, duration, and deferred wake-up
 * signal. `sleep` ignores zero durations, runs short sleeps through an
 * in-memory activity, and schedules longer sleeps through the `WorkflowEngine`
 * before awaiting the durable deferred tied to the clock.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as Activity from "./Activity.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/DurableClock"

/**
 * Represents a durable workflow timer with a name, duration, and deferred
 * completed when the timer wakes.
 *
 * @category models
 * @since 4.0.0
 */
export interface DurableClock {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly duration: Duration.Duration
  readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>
}

/**
 * Creates a durable clock definition and its associated deferred wake-up
 * signal.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: {
  readonly name: string
  readonly duration: Duration.Input
}): DurableClock => ({
  [TypeId]: TypeId,
  name: options.name,
  duration: Duration.fromInputUnsafe(options.duration),
  deferred: DurableDeferred.make(`DurableClock/${options.name}`)
})

const EngineTag = Context.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)

const InstanceTag = Context.Service<
  WorkflowInstance,
  WorkflowInstance["Service"]
>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

/**
 * Waits inside a workflow, using an in-memory activity for durations at or
 * below the threshold and scheduling a durable clock for longer durations.
 *
 * @category sleeping
 * @since 4.0.0
 */
export const sleep: (
  options: {
    readonly name: string
    readonly duration: Duration.Input
    /**
     * If the duration is less than or equal to this threshold, the clock will
     * be executed in memory.
     *
     * @default 60 seconds
     */
    readonly inMemoryThreshold?: Duration.Input | undefined
  }
) => Effect.Effect<
  void,
  never,
  WorkflowEngine | WorkflowInstance
> =
  // Untraced because durable sleeps are recursively resumed by the engine.
  Effect.fnUntraced(function*(options: {
    readonly name: string
    readonly duration: Duration.Input
    readonly inMemoryThreshold?: Duration.Input | undefined
  }) {
    const duration = Duration.fromInputUnsafe(options.duration)
    if (Duration.isZero(duration)) {
      return
    }

    const inMemoryThreshold = options.inMemoryThreshold
      ? Duration.fromInputUnsafe(options.inMemoryThreshold)
      : defaultInMemoryThreshold

    if (Duration.isLessThanOrEqualTo(duration, inMemoryThreshold)) {
      return yield* Activity.make({
        name: `DurableClock/${options.name}`,
        tier: "sealed",
        execute: Effect.sleep(duration)
      })
    }

    const engine = yield* EngineTag
    const instance = yield* InstanceTag
    const clock = make(options)
    yield* engine.scheduleClock(instance.workflow, {
      executionId: instance.executionId,
      clock
    })
    return yield* DurableDeferred.await(clock.deferred)
  })

const defaultInMemoryThreshold = Duration.seconds(60)
