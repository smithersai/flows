/**
 * A minimal in-memory implementation of the `FlowRuntime` port, used to
 * exercise the authoring APIs this package owns.
 *
 * `@smthrs/flow` deliberately does not depend on anything that executes
 * flows, so its suite cannot reach for `@smthrs/engine`'s `layerMemory`. This
 * fixture is the smallest runtime the authoring surface needs: it registers
 * handlers, drives suspension and resumption, memoizes activity outcomes per
 * (identity, attempt), and records durable deferred results. Everything the
 * real engine adds on top — step-key derivation, ordinal pinning, retry
 * policy decisions, snapshot boundaries — is tested in `@smthrs/engine`,
 * against the engine that owns it.
 */
import { Activity, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

/** Builds the per-execution state the port's combinators read and update. */
export const makeInstance = (
  flow: Flow.Any,
  executionId: string
): FlowRuntime.FlowInstance["Service"] => {
  const ordinals = new Map<string, number>()
  return FlowRuntime.FlowInstance.of({
    executionId,
    lineageId: `${executionId}/root`,
    flow,
    scope: Scope.makeUnsafe(),
    suspended: false,
    interrupted: false,
    waiting: undefined,
    handoff: undefined,
    cause: undefined,
    activityState: {
      count: 0,
      latch: Latch.makeUnsafe(),
      nextOrdinal: (scope: string) => {
        const next = (ordinals.get(scope) ?? 0) + 1
        ordinals.set(scope, next)
        return next
      },
      snapshots: new Map(),
      keylessInFlight: new Set()
    }
  })
}

const toJsonExit = Exit.map((value: any) => value ?? null)

type Handler = (
  payload: object,
  executionId: string
) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>

type ExecutionState = {
  readonly payload: object
  readonly handler: Handler
  readonly parent: string | undefined
  instance: FlowRuntime.FlowInstance["Service"]
  fiber: Fiber.Fiber<Flow.Result<unknown, unknown>> | undefined
}

/**
 * A `FlowRuntime` layer that keeps every execution, activity outcome, and
 * durable deferred result in process memory.
 */
export const layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> = Layer.effect(FlowRuntime.FlowRuntime)(
  Effect.gen(function*() {
    const rootScope = yield* Effect.scope
    const flows = new Map<string, { readonly handler: Handler; readonly scope: Scope.Scope }>()
    const executions = new Map<string, ExecutionState>()
    const activities = new Map<string, Exit.Exit<Flow.Result<unknown, unknown>>>()
    const deferredResults = new Map<string, Exit.Exit<any, any>>()
    const clocks = yield* FiberMap.make<string>()

    const drive = Effect.fnUntraced(function*(executionId: string): Effect.fn.Return<void> {
      const state = executions.get(executionId)
      if (!state) return
      const exit = state.fiber?.pollUnsafe()
      if (exit && exit._tag === "Success" && exit.value._tag === "Complete") return
      if (state.fiber && !exit) return

      const entry = flows.get(state.instance.flow._tag)!
      const instance = makeInstance(state.instance.flow, executionId)
      instance.interrupted = state.instance.interrupted
      state.instance = instance
      state.fiber = yield* state.handler(state.payload, executionId).pipe(
        Effect.onExit(() => {
          if (!instance.interrupted) return Effect.void
          instance.suspended = false
          return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
        }),
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime),
        Effect.tap((result) =>
          !state.parent || result._tag !== "Complete"
            ? Effect.void
            : Effect.forkIn(drive(state.parent), rootScope)
        ),
        Effect.forkIn(entry.scope)
      )
    })

    const start = Effect.fnUntraced(function*(
      flow: Flow.Any,
      executionId: string,
      payload: object,
      parent: string | undefined
    ) {
      let state = executions.get(executionId)
      if (!state) {
        const entry = flows.get(flow._tag)
        if (!entry) return yield* Effect.die(`Flow ${flow._tag} is not registered`)
        state = {
          payload,
          handler: entry.handler,
          instance: makeInstance(flow, executionId),
          fiber: undefined,
          parent
        }
        executions.set(executionId, state)
        yield* drive(executionId)
      }
      return state
    })

    const runtime: FlowRuntime.FlowRuntime["Service"] = FlowRuntime.FlowRuntime.of({
      register: Effect.fnUntraced(function*(flow, execute) {
        const services = yield* Effect.context<FlowRuntime.FlowRuntime>()
        const scope = yield* Effect.scope
        flows.set(flow._tag, {
          scope,
          handler: (payload, executionId) =>
            Effect.suspend(() => execute(payload as any, executionId)).pipe(
              Effect.updateContext((input) => Context.merge(services, input) as Context.Context<any>)
            ) as Handler extends (...args: never) => infer R ? R : never
        })
      }) as any,
      execute: Effect.fnUntraced(function*(flow: any, options: any) {
        const parentInstance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
        const state = yield* start(
          flow,
          options.executionId,
          options.payload,
          Option.isSome(parentInstance) ? parentInstance.value.executionId : undefined
        )
        if (options.discard) return options.executionId
        if (Option.isSome(parentInstance)) {
          const wrapped = yield* Flow.wrapActivityResult(
            Fiber.join(state.fiber!) as Effect.Effect<Flow.Result<unknown, unknown>>,
            (result) => result._tag === "Suspended"
          )
          if (wrapped._tag !== "Complete") return yield* Flow.suspend(parentInstance.value)
          return yield* wrapped.exit
        }
        while (true) {
          const wrapped = yield* (Fiber.join(state.fiber!) as Effect.Effect<Flow.Result<unknown, unknown>>)
          if (wrapped._tag === "Complete") return yield* (wrapped.exit as unknown as Effect.Effect<any>)
          // The port fixture does not follow a lineage — that is the engine's
          // job — so a round that handed off settles as itself here.
          if (wrapped._tag === "Handoff") return wrapped as never
          yield* Effect.sleep(1)
          yield* drive(options.executionId)
        }
      }) as any,
      poll: ((_flow: any, executionId: string) =>
        Effect.suspend(() => {
          const state = executions.get(executionId)
          const exit = state?.fiber?.pollUnsafe()
          if (!exit) return Effect.succeedNone
          return exit._tag === "Success" ? Effect.succeedSome(exit.value) : Effect.die(exit.cause)
        })) as any,
      interrupt: Effect.fnUntraced(function*(_flow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        yield* drive(executionId)
      }),
      interruptUnsafe: Effect.fnUntraced(function*(_flow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        yield* Fiber.interrupt(state.fiber!)
      }),
      resume: (_flow, executionId) => drive(executionId) as Effect.Effect<void>,
      activityExecute: Effect.fnUntraced(function*(activity: any, attempt: number) {
        const instance = yield* FlowRuntime.FlowInstance
        const scope = `${activity.name}/${JSON.stringify(activity.idempotencyKey ?? null)}`
        const slot = yield* Activity.CurrentOrdinal
        let ordinal: number
        if (slot === undefined) {
          ordinal = instance.activityState.nextOrdinal(scope)
        } else {
          const index = slot.cursors.get(scope) ?? 0
          slot.cursors.set(scope, index + 1)
          const pinned = slot.values.get(scope) ?? []
          if (index < pinned.length) {
            ordinal = pinned[index]!
          } else {
            ordinal = instance.activityState.nextOrdinal(scope)
            pinned.push(ordinal)
            slot.values.set(scope, pinned)
          }
        }
        const id = JSON.stringify([instance.executionId, scope, ordinal, attempt])
        const memo = activities.get(id)
        if (memo && !(memo._tag === "Success" && memo.value._tag === "Suspended")) {
          const replayed = yield* memo
          if (replayed._tag !== "Complete") return replayed
          return new Flow.Complete({
            exit: yield* Effect.orDie(
              Schema.decodeEffect(activity.exitSchemaPartial)(toJsonExit(replayed.exit))
            )
          }) as any
        }
        const activityInstance = makeInstance(instance.flow, instance.executionId)
        activityInstance.interrupted = instance.interrupted
        const result = (yield* (activity.executeEncoded.pipe(
          Flow.intoResult,
          Effect.provideService(FlowRuntime.FlowInstance, activityInstance),
          Effect.provideService(Activity.CurrentAttempt, attempt),
          Effect.onExit((exit: any) => Effect.sync(() => activities.set(id, exit)))
        ) as Effect.Effect<Flow.Result<unknown, unknown>>)) as Flow.Result<unknown, unknown>
        if (result._tag !== "Complete") return result as never
        return new Flow.Complete({
          exit: yield* Effect.orDie(
            Schema.decodeEffect(activity.exitSchemaPartial)(toJsonExit(result.exit))
          )
        }) as any
      }) as any,
      deferredResult: Effect.fnUntraced(function*(deferred: any) {
        const instance = yield* FlowRuntime.FlowInstance
        const stored = deferredResults.get(`${instance.executionId}/${deferred.name}`)
        if (stored === undefined) return Option.none()
        instance.waiting = undefined
        return Option.some(
          yield* Effect.orDie(Schema.decodeEffect(deferred.exitSchema)(toJsonExit(stored)))
        )
      }) as any,
      deferredDone: ((deferred: any, options: any) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(deferred.exitSchema)(options.exit) as Effect.Effect<
            Exit.Exit<unknown, unknown>
          >
          const id = `${options.executionId}/${options.deferredName}`
          if (deferredResults.has(id)) return
          deferredResults.set(id, encoded)
          yield* drive(options.executionId)
        })) as any,
      scheduleClock: (flow, options) =>
        runtime.deferredDone(options.clock.deferred as any, {
          flowName: flow._tag,
          executionId: options.executionId,
          deferredName: options.clock.deferred.name,
          exit: Exit.void
        }).pipe(
          Effect.delay(options.clock.duration),
          FiberMap.run(clocks, `${options.executionId}/${options.clock.name}`, { onlyIfMissing: true }),
          Effect.asVoid
        ) as Effect.Effect<void>
    })

    return runtime
  })
)

/** Re-exported for the suites that only need the deferred token helpers. */
export const token = DurableDeferred.token
