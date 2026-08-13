// Deep reviewed and polished by a human on 2026-08-10.

/**
 * A volatile, in-memory implementation of the flow runtime port.
 *
 * @since 4.0.0
 */
import { Flow, FlowRuntime } from "@smthrs/flow-next"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { makeInstance } from "./FlowInstance.ts"
import { makeUnsafe } from "./make.ts"

/**
 * Layer that provides an in-memory `FlowRuntime`.
 *
 * **When to use**
 *
 * Use to run tests and local development flows where durability is not
 * needed.
 *
 * **Gotchas**
 *
 * This layer keeps state only in memory and is not suitable for production
 * flows that require durability.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> = Layer.effect(FlowRuntime.FlowRuntime)(
  Effect.gen(function*() {
    const scope = yield* Effect.scope

    const flows = new Map<string, {
      readonly flow: Flow.Any
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
      readonly scope: Scope.Scope
    }>()

    type ExecutionState = {
      readonly payload: object
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
      readonly parent: string | undefined
      instance: FlowRuntime.FlowInstance["Service"]
      fiber: Fiber.Fiber<Flow.Result<unknown, unknown>> | undefined
    }
    const executions = new Map<string, ExecutionState>()

    type ActivityState = {
      exit: Exit.Exit<Flow.Result<unknown, unknown>> | undefined
    }
    const activities = new Map<string, ActivityState>()

    // Untraced because resume recursively drives suspended executions.
    const resume = Effect.fnUntraced(function*(executionId: string): Effect.fn.Return<void> {
      const state = executions.get(executionId)
      if (!state) return
      const exit = state.fiber?.pollUnsafe()
      // Suspension is the only settlement a re-drive continues from: a round
      // that completed has its answer, and one that handed off has already
      // opened the next round, so re-running either would re-run its effects.
      if (exit && exit._tag === "Success" && exit.value._tag !== "Suspended") {
        return
      } else if (state.fiber && !exit) {
        return
      }

      const entry = flows.get(state.instance.flow._tag)!
      const instance = makeInstance(state.instance.flow, state.instance.executionId)
      instance.interrupted = state.instance.interrupted
      state.instance = instance
      state.fiber = yield* state.execute(state.payload, state.instance.executionId).pipe(
        Effect.onExit(() => {
          if (!instance.interrupted) {
            return Effect.void
          }
          instance.suspended = false
          return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
        }),
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, engine),
        Effect.tap((result) => {
          if (!state.parent || result._tag !== "Complete") {
            return Effect.void
          }
          return Effect.forkIn(resume(state.parent), scope)
        }),
        Effect.forkIn(entry.scope)
      )
    })

    const deferredResults = new Map<string, Exit.Exit<any, any>>()

    const clocks = yield* FiberMap.make<string>()

    const engine = makeUnsafe({
      // Untraced because registration feeds back into the in-memory engine.
      register: Effect.fnUntraced(function*(flow, execute) {
        flows.set(flow._tag, {
          flow,
          execute,
          scope: yield* Effect.scope
        })
      }),
      // Untraced because execution recursively invokes child flows.
      execute: Effect.fnUntraced(function*(flow, options) {
        const entry = flows.get(flow._tag)
        if (!entry) {
          return yield* Effect.orDie(Effect.fail(`Flow ${flow._tag} is not registered`))
        }

        let state = executions.get(options.executionId)
        if (!state) {
          state = {
            payload: options.payload,
            execute: entry.execute,
            instance: makeInstance(flow, options.executionId),
            fiber: undefined,
            parent: options.parent?.executionId
          }
          executions.set(options.executionId, state)
          yield* resume(options.executionId)
        }
        if (options.discard) return
        return (yield* Fiber.join(state.fiber!)) as any
      }),
      // Untraced because interruption is coordinated from recursive execution.
      interrupt: Effect.fnUntraced(function*(_flow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        yield* resume(executionId)
      }),
      // Untraced because interruption is coordinated from recursive execution.
      interruptUnsafe: Effect.fnUntraced(function*(_flow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        // `execute` installs the state and synchronously starts `resume`
        // before it can return its execution id. `resume` assigns this fiber
        // without yielding, so every publicly observable execution has one.
        yield* Fiber.interrupt(state.fiber!)
      }),
      resume(_flow, executionId) {
        return resume(executionId)
      },
      // Untraced because activity execution is a retry-loop hot path.
      activityExecute: Effect.fnUntraced(function*(options) {
        const activity = options.activity
        const instance = yield* FlowRuntime.FlowInstance
        const activityId = JSON.stringify([options.key, options.attempt])
        let state = activities.get(activityId)
        if (state) {
          const exit = state.exit
          if (exit && exit._tag === "Success" && exit.value._tag === "Suspended") {
            state.exit = undefined
          } else if (exit) {
            return yield* exit
          }
        } else {
          state = { exit: undefined }
          activities.set(activityId, state)
        }
        const activityInstance = makeInstance(instance.flow, instance.executionId)
        activityInstance.interrupted = instance.interrupted
        // DECIDED (2026-08-11, pending review): the waiting classification is
        // threaded through the dispatch's instance and back, because a driver
        // gives an activity its own instance while `annotateWaiting` is
        // documented to reach the parked run. An implementation that declares
        // one — `Sleep` under `timer`, `WaitFor` under `event` with its wake
        // token — writes it here, so without the thread-back the driver would
        // park on the derived default and the declaration would be inert for
        // every activity. It is seeded as well as copied back so a body that
        // annotated before dispatching keeps its own declaration, and so the
        // consumption `deferredResult` performs on a settled wait travels out
        // the same way (issue #42).
        const waitingBefore = instance.waiting
        activityInstance.waiting = waitingBefore
        return yield* activity.executeEncoded.pipe(
          Flow.intoResult,
          Effect.provideService(FlowRuntime.FlowInstance, activityInstance),
          Effect.onExit((exit) => {
            state.exit = exit
            return Effect.void
          }),
          Effect.ensuring(Effect.sync(() => {
            if (instance.waiting === waitingBefore) instance.waiting = activityInstance.waiting
          }))
        )
      }),
      poll: (_flow, executionId) =>
        Effect.suspend(() => {
          const state = executions.get(executionId)
          if (!state) {
            return Effect.succeedNone
          }
          const exit = state.fiber?.pollUnsafe()
          if (!exit) {
            return Effect.succeedNone
          }
          return exit._tag === "Success"
            ? Effect.succeedSome(exit.value)
            : Effect.die(exit.cause)
        }),
      // Untraced because deferred polling is a flow scheduler hot path.
      deferredResult: Effect.fnUntraced(function*(deferred) {
        const instance = yield* FlowRuntime.FlowInstance
        const id = `${instance.executionId}/${deferred.name}`
        return Option.fromNullishOr(deferredResults.get(id))
      }),
      deferredDone: (options) =>
        Effect.suspend(() => {
          const id = `${options.executionId}/${options.deferredName}`
          if (deferredResults.has(id)) return Effect.void
          deferredResults.set(id, options.exit)
          return resume(options.executionId)
        }),
      scheduleClock: (flow, options) =>
        engine.deferredDone(options.clock.deferred, {
          flowName: flow._tag,
          executionId: options.executionId,
          deferredName: options.clock.deferred.name,
          exit: Exit.void
        }).pipe(
          Effect.delay(options.clock.duration),
          FiberMap.run(clocks, `${options.executionId}/${options.clock.name}`, { onlyIfMissing: true }),
          Effect.asVoid
        )
    })

    return engine
  })
)
