/**
 * Defines workflow engine services and an in-memory implementation.
 *
 * `WorkflowEngine` registers workflow handlers, runs executions, polls results,
 * resumes suspended runs, executes activities, stores durable deferred results,
 * and schedules durable clocks. `WorkflowInstance` holds the runtime state for
 * one workflow run. The in-memory layer is useful for tests and local
 * development.
 *
 * @since 4.0.0
 */
import * as StepKey from "@flows/keys/StepKey"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Activity from "./Activity.ts"
import type { DurableClock } from "./DurableClock.ts"
import type * as DurableDeferred from "./DurableDeferred.ts"
import * as Workflow from "./Workflow.ts"

/**
 * The identity and boundary information supplied to an encoded activity
 * executor.
 *
 * @category models
 * @since 0.1.0
 */
export interface ActivityExecuteOptions {
  readonly activity: Activity.Any
  readonly attempt: number
  readonly key: string
  readonly tier: Activity.Tier
  readonly metadata: unknown
}

/**
 * Context passed to a compensable activity snapshot boundary.
 *
 * @category models
 * @since 0.1.0
 */
export interface SnapshotBoundaryOptions {
  readonly workflow: Workflow.Any
  readonly executionId: string
  readonly key: string
  readonly attempt: number
  readonly metadata: unknown
}

/**
 * Minimal host snapshot boundary required by compensable activities.
 *
 * TODO(piece-6): bind to @flows/kernel Jj in @flows/engine-store.
 *
 * @category services
 * @since 0.1.0
 */
export class SnapshotBoundary extends Context.Service<
  SnapshotBoundary,
  {
    readonly snapshot: (options: SnapshotBoundaryOptions) => Effect.Effect<unknown>
    readonly restore: (
      snapshot: unknown,
      options: SnapshotBoundaryOptions
    ) => Effect.Effect<void>
    readonly diff: (
      snapshot: unknown,
      options: SnapshotBoundaryOptions
    ) => Effect.Effect<unknown>
  }
>()("flows/workflow-engine/SnapshotBoundary") {}

/**
 * Service that represents workflow runtimes, responsible for registering and
 * executing workflows and coordinating activities, durable deferreds,
 * interrupts, resumes, and clocks.
 *
 * @category services
 * @since 4.0.0
 */
export class WorkflowEngine extends Context.Service<
  WorkflowEngine,
  {
    /**
     * Register a workflow with the engine.
     */
    readonly register: <
      Name extends string,
      Payload extends Workflow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      R
    >(
      workflow: Workflow.Workflow<Name, Payload, Success, Error>,
      execute: (
        payload: Payload["Type"],
        executionId: string
      ) => Effect.Effect<Success["Type"], Error["Type"], R>
    ) => Effect.Effect<
      void,
      never,
      | Scope.Scope
      | Exclude<
        R,
        | WorkflowEngine
        | WorkflowInstance
        | Workflow.Execution<Name>
        | Scope.Scope
      >
      | Payload["DecodingServices"]
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Success["EncodingServices"]
      | Error["DecodingServices"]
      | Error["EncodingServices"]
    >

    /**
     * Execute a registered workflow.
     */
    readonly execute: <
      Name extends string,
      Payload extends Workflow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      workflow: Workflow.Workflow<Name, Payload, Success, Error>,
      options: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetrySchedule?:
          | Schedule.Schedule<any, unknown>
          | undefined
      }
    ) => Effect.Effect<
      Discard extends true ? string : Success["Type"],
      Error["Type"],
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Error["DecodingServices"]
    >

    /**
     * Poll the current status of a registered workflow execution.
     */
    readonly poll: <
      Name extends string,
      Payload extends Workflow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top
    >(
      workflow: Workflow.Workflow<Name, Payload, Success, Error>,
      executionId: string
    ) => Effect.Effect<
      Option.Option<Workflow.Result<Success["Type"], Error["Type"]>>,
      never,
      Success["DecodingServices"] | Error["DecodingServices"]
    >

    /**
     * Interrupt a registered workflow.
     */
    readonly interrupt: (
      workflow: Workflow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Interrupts a registered workflow unsafely, potentially ignoring
     * compensation finalizers and orphaning child workflows.
     */
    readonly interruptUnsafe: (
      workflow: Workflow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Resume a registered workflow.
     */
    readonly resume: (
      workflow: Workflow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Execute an activity from a workflow.
     */
    readonly activityExecute: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(
      activity: Activity.Activity<Success, Error, R>,
      attempt: number
    ) => Effect.Effect<
      Workflow.Result<Success["Type"], Error["Type"]>,
      never,
      | Success["DecodingServices"]
      | Error["DecodingServices"]
      | R
      | WorkflowInstance
    >

    /**
     * Try to retrieve the result of an DurableDeferred
     */
    readonly deferredResult: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>
    ) => Effect.Effect<
      Option.Option<Exit.Exit<Success["Type"], Error["Type"]>>,
      never,
      WorkflowInstance
    >

    /**
     * Set the result of a DurableDeferred, and then resume any waiting
     * workflows.
     */
    readonly deferredDone: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>,
      options: {
        readonly workflowName: string
        readonly executionId: string
        readonly deferredName: string
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
      }
    ) => Effect.Effect<
      void,
      never,
      Success["EncodingServices"] | Error["EncodingServices"]
    >

    /**
     * Schedule a wake up for a DurableClock
     */
    readonly scheduleClock: (
      workflow: Workflow.Any,
      options: {
        readonly executionId: string
        readonly clock: DurableClock
      }
    ) => Effect.Effect<void>
  }
>()("effect/workflow/WorkflowEngine") {}

/**
 * Service that contains workflow runtime state for one execution.
 *
 * **When to use**
 *
 * Use to read or update workflow execution, suspension, interruption,
 * lifetime, failure, and activity coordination state inside workflow engine
 * internals.
 *
 * **Details**
 *
 * The service stores the execution ID, workflow definition, long-lived scope,
 * suspension and interruption flags, the stored failure cause, and activity
 * coordination state for a single workflow run.
 *
 * @category services
 * @since 4.0.0
 */
export class WorkflowInstance extends Context.Service<
  WorkflowInstance,
  {
    /**
     * The workflow execution ID.
     */
    readonly executionId: string

    /**
     * The workflow definition.
     */
    readonly workflow: Workflow.Any

    /**
     * A scope that represents the lifetime of the workflow.
     *
     * It is only closed when the workflow is completed.
     */
    readonly scope: Scope.Closeable

    /**
     * Whether the workflow has requested to be suspended.
     */
    suspended: boolean

    /**
     * Whether the workflow has requested to be interrupted.
     */
    interrupted: boolean

    /**
     * When SuspendOnFailure is triggered, the cause of the failure is stored
     * here.
     */
    cause: Cause.Cause<never> | undefined

    readonly activityState: {
      count: number
      readonly latch: Latch.Latch
      readonly nextOrdinal: () => number
      readonly snapshots: Map<string, unknown>
    }
  }
>()("effect/workflow/WorkflowEngine/WorkflowInstance") {
  static initial(
    workflow: Workflow.Any,
    executionId: string
  ): WorkflowInstance["Service"] {
    let ordinal = 0
    return WorkflowInstance.of({
      executionId,
      workflow,
      scope: Scope.makeUnsafe(),
      suspended: false,
      interrupted: false,
      cause: undefined,
      activityState: {
        count: 0,
        latch: Latch.makeUnsafe(),
        nextOrdinal: () => ++ordinal,
        snapshots: new Map()
      }
    })
  }
}

/**
 * Low-level workflow engine contract that works with encoded payloads and
 * results before `makeUnsafe` adds typed schema decoding and encoding.
 *
 * @category Encoded
 * @since 4.0.0
 */
export interface Encoded {
  readonly register: (
    workflow: Workflow.Any,
    execute: (
      payload: object,
      executionId: string
    ) => Effect.Effect<unknown, unknown, WorkflowInstance | WorkflowEngine>
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly execute: <const Discard extends boolean>(
    workflow: Workflow.Any,
    options: {
      readonly executionId: string
      readonly payload: object
      readonly discard: Discard
      readonly parent?: WorkflowInstance["Service"] | undefined
    }
  ) => Effect.Effect<
    Discard extends true ? void : Workflow.Result<unknown, unknown>
  >
  readonly poll: (
    workflow: Workflow.Any,
    executionId: string
  ) => Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>>
  readonly interrupt: (
    workflow: Workflow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly interruptUnsafe: (
    workflow: Workflow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly resume: (
    workflow: Workflow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly resumeSignal?:
    | ((
      workflow: Workflow.Any,
      executionId: string
    ) => Effect.Effect<void>)
    | undefined
  readonly activityExecute: (
    options: ActivityExecuteOptions
  ) => Effect.Effect<
    Workflow.Result<unknown, unknown>,
    never,
    WorkflowInstance
  >
  readonly deferredResult: (
    deferred: DurableDeferred.Any
  ) => Effect.Effect<
    Option.Option<Exit.Exit<unknown, unknown>>,
    never,
    WorkflowInstance
  >
  readonly deferredDone: (options: {
    readonly workflowName: string
    readonly executionId: string
    readonly deferredName: string
    readonly exit: Exit.Exit<unknown, unknown>
  }) => Effect.Effect<void>
  readonly scheduleClock: (
    workflow: Workflow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock
    }
  ) => Effect.Effect<void>
}

const activityKey = (
  activity: Activity.Any,
  executionId: string,
  ordinal: number
): string => {
  if (activity.tier === "sealed" && activity.idempotencyKey !== undefined) {
    return Result.getOrThrow(StepKey.content(
      typeof activity.idempotencyKey === "string"
        ? {
          body: activity.idempotencyKey,
          inputs: {},
          layers: [],
          capabilities: {}
        }
        : activity.idempotencyKey
    ))
  }
  return Result.getOrThrow(StepKey.ordinal({
    runId: executionId,
    ordinal,
    tier: activity.tier === "sealed" ? "unsealed" : activity.tier
  }))
}

/**
 * Builds a typed `WorkflowEngine` service from a low-level encoded
 * implementation.
 *
 * **When to use**
 *
 * Use when wiring a trusted low-level workflow engine implementation into the
 * typed `WorkflowEngine` service.
 *
 * **Gotchas**
 *
 * The implementation must correctly persist, resume, and encode workflow state.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe = (options: Encoded): WorkflowEngine["Service"] =>
  WorkflowEngine.of({
    // Untraced because registering a workflow recursively re-enters the engine.
    register: Effect.fnUntraced(function*(workflow, execute) {
      const services = yield* Effect.context<WorkflowEngine>()
      yield* options.register(workflow, (payload, executionId) =>
        Effect.suspend(() =>
          execute(payload, executionId)
        ).pipe(
          Effect.updateContext(
            (input) => Context.merge(services, input) as Context.Context<any>
          )
        ))
    }),
    // Untraced because workflow execution recursively invokes child workflows.
    execute: Effect.fnUntraced(function*<
      Name extends string,
      Payload extends Workflow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      self: Workflow.Workflow<Name, Payload, Success, Error>,
      opts: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetrySchedule?:
          | Schedule.Schedule<any, unknown>
          | undefined
      }
    ) {
      const payload = opts.payload
      const executionId = opts.executionId
      const suspendedRetrySchedule = opts.suspendedRetrySchedule ?? defaultRetrySchedule
      yield* Effect.annotateCurrentSpan({ executionId })
      let result = Option.none<Workflow.Result<Success["Type"], Error["Type"]>>()

      // link interruption with parent workflow
      const parentInstance = yield* Effect.serviceOption(WorkflowInstance)
      if (Option.isSome(parentInstance)) {
        const instance = parentInstance.value
        yield* Effect.addFinalizer(() => {
          if (!instance.interrupted || (Option.isSome(result) && result.value._tag === "Complete")) {
            return Effect.void
          }
          return options.interrupt(self, executionId)
        })
      }
      const run = options.execute(self, {
        executionId,
        payload: payload as object,
        discard: opts.discard ?? false,
        parent: Option.getOrUndefined(parentInstance)
      }) as Effect.Effect<Workflow.Result<Success["Type"], Error["Type"]>>

      if (opts.discard) {
        yield* run
        return executionId
      }

      if (Option.isSome(parentInstance)) {
        const wrapped = yield* Workflow.wrapActivityResult(
          run,
          (result) => result._tag === "Suspended"
        )
        result = Option.some(wrapped)
        if (wrapped._tag === "Suspended") {
          return yield* Workflow.suspend(parentInstance.value)
        }
        return yield* wrapped.exit
      }

      let sleep: Effect.Effect<any> | undefined
      while (true) {
        const wrapped = yield* run
        result = Option.some(wrapped)
        if (wrapped._tag === "Complete") {
          return yield* wrapped.exit as Exit.Exit<any>
        }
        sleep ??= (yield* Schedule.toStepWithSleep(suspendedRetrySchedule))(
          void 0
        ).pipe(
          Effect.catch(() =>
            Effect.die(
              `${self._tag}.execute: suspendedRetrySchedule exhausted`
            )
          )
        )
        yield* (options.resumeSignal === undefined
          ? sleep
          : Effect.raceFirst(sleep, options.resumeSignal(self, executionId)))
      }
    }),
    poll: options.poll,
    interrupt: options.interrupt,
    interruptUnsafe: options.interruptUnsafe,
    resume: options.resume,
    // Untraced because activity retries are a hot path within a workflow run.
    activityExecute: Effect.fnUntraced(function*<
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(activity: Activity.Activity<Success, Error, R>, attempt: number) {
      const instance = yield* WorkflowInstance
      const currentOrdinal = yield* Activity.CurrentOrdinal
      const key = activityKey(
        activity,
        instance.executionId,
        currentOrdinal ?? instance.activityState.nextOrdinal()
      )
      if (
        activity.tier === "irreversible" &&
        attempt > 1 &&
        activity.idempotencyKey === undefined
      ) {
        return yield* Effect.die(
          new Activity.IrreversibleRetryRequiresIdempotencyKey({
            activityName: activity.name,
            attempt
          })
        )
      }
      const input: ActivityExecuteOptions = {
        activity,
        attempt,
        key,
        tier: activity.tier,
        metadata: activity.metadata
      }
      let result: Workflow.Result<unknown, unknown>
      if (activity.tier === "compensable") {
        const boundaryOption = yield* Effect.serviceOption(SnapshotBoundary)
        if (Option.isNone(boundaryOption)) {
          return yield* Effect.die(
            `Compensable activity "${activity.name}" requires SnapshotBoundary`
          )
        }
        const boundary = boundaryOption.value
        const boundaryOptions: SnapshotBoundaryOptions = {
          workflow: instance.workflow,
          executionId: instance.executionId,
          key,
          attempt,
          metadata: activity.metadata
        }
        if (attempt > 1 && instance.activityState.snapshots.has(key)) {
          yield* boundary.restore(
            instance.activityState.snapshots.get(key),
            boundaryOptions
          )
        }
        const snapshot = yield* boundary.snapshot(boundaryOptions)
        instance.activityState.snapshots.set(key, snapshot)
        result = yield* options.activityExecute(input).pipe(
          Effect.ensuring(Effect.asVoid(boundary.diff(snapshot, boundaryOptions)))
        )
      } else {
        result = yield* options.activityExecute(input)
      }
      if (result._tag === "Suspended") {
        return result
      }
      const exit = yield* Effect.orDie(
        Schema.decodeEffect(activity.exitSchemaPartial)(toJsonExit(result.exit))
      )
      return new Workflow.Complete({ exit })
    }),
    // Untraced because the explicit span below carries deferred attributes.
    deferredResult: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>
      ) {
        const instance = yield* WorkflowInstance
        yield* Effect.annotateCurrentSpan({
          executionId: instance.executionId
        })
        const exit = yield* options.deferredResult(deferred)
        if (Option.isNone(exit)) {
          return Option.none()
        }
        return Option.some(
          yield* Effect.orDie(
            Schema.decodeEffect(deferred.exitSchema)(toJsonExit(exit.value))
          ) as Effect.Effect<Exit.Exit<Success["Type"], Error["Type"]>>
        )
      },
      Effect.withSpan(
        "WorkflowEngine.deferredResult",
        (deferred) => ({
          attributes: { name: deferred.name }
        }),
        { captureStackTrace: false }
      )
    ),
    // Untraced because the explicit span below carries completion attributes.
    deferredDone: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>,
        opts: {
          readonly workflowName: string
          readonly executionId: string
          readonly deferredName: string
          readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
        }
      ) {
        return yield* options.deferredDone({
          workflowName: opts.workflowName,
          executionId: opts.executionId,
          deferredName: opts.deferredName,
          exit: yield* Schema.encodeEffect(deferred.exitSchema)(
            opts.exit
          ) as Effect.Effect<Exit.Exit<unknown, unknown>>
        })
      },
      Effect.withSpan(
        "WorkflowEngine.deferredDone",
        (_, { deferredName, executionId }) => ({
          attributes: { name: deferredName, executionId }
        }),
        { captureStackTrace: false }
      )
    ),
    scheduleClock: Effect.fn("WorkflowEngine.scheduleClock")((workflow, opts) =>
      options.scheduleClock(workflow, opts).pipe(
        Effect.withSpan(
          "WorkflowEngine.scheduleClock",
          {
            attributes: {
              executionId: opts.executionId,
              name: opts.clock.name
            }
          },
          {
            captureStackTrace: false
          }
        )
      )
    )
  })

const defaultRetrySchedule = Schedule.min([
  Schedule.exponential(200, 1.5),
  Schedule.spaced(30000)
])

/**
 * Layer that provides an in-memory `WorkflowEngine`.
 *
 * **When to use**
 *
 * Use to run tests and local development workflows where durability is not
 * needed.
 *
 * **Gotchas**
 *
 * This layer keeps state only in memory and is not suitable for production
 * workflows that require durability.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMemory: Layer.Layer<WorkflowEngine> = Layer.effect(WorkflowEngine)(
  Effect.gen(function*() {
    const scope = yield* Effect.scope

    const workflows = new Map<string, {
      readonly workflow: Workflow.Any
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, WorkflowInstance | WorkflowEngine>
      readonly scope: Scope.Scope
    }>()

    type ExecutionState = {
      readonly payload: object
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, WorkflowInstance | WorkflowEngine>
      readonly parent: string | undefined
      instance: WorkflowInstance["Service"]
      fiber: Fiber.Fiber<Workflow.Result<unknown, unknown>> | undefined
    }
    const executions = new Map<string, ExecutionState>()

    type ActivityState = {
      exit: Exit.Exit<Workflow.Result<unknown, unknown>> | undefined
    }
    const activities = new Map<string, ActivityState>()

    // Untraced because resume recursively drives suspended executions.
    const resume = Effect.fnUntraced(function*(executionId: string): Effect.fn.Return<void> {
      const state = executions.get(executionId)
      if (!state) return
      const exit = state.fiber?.pollUnsafe()
      if (exit && exit._tag === "Success" && exit.value._tag === "Complete") {
        return
      } else if (state.fiber && !exit) {
        return
      }

      const entry = workflows.get(state.instance.workflow._tag)!
      const instance = WorkflowInstance.initial(state.instance.workflow, state.instance.executionId)
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
        Workflow.intoResult,
        Effect.provideService(WorkflowInstance, instance),
        Effect.provideService(WorkflowEngine, engine),
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
      register: Effect.fnUntraced(function*(workflow, execute) {
        workflows.set(workflow._tag, {
          workflow,
          execute,
          scope: yield* Effect.scope
        })
      }),
      // Untraced because execution recursively invokes child workflows.
      execute: Effect.fnUntraced(function*(workflow, options) {
        const entry = workflows.get(workflow._tag)
        if (!entry) {
          return yield* Effect.orDie(Effect.fail(`Workflow ${workflow._tag} is not registered`))
        }

        let state = executions.get(options.executionId)
        if (!state) {
          state = {
            payload: options.payload,
            execute: entry.execute,
            instance: WorkflowInstance.initial(workflow, options.executionId),
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
      interrupt: Effect.fnUntraced(function*(_workflow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        yield* resume(executionId)
      }),
      // Untraced because interruption is coordinated from recursive execution.
      interruptUnsafe: Effect.fnUntraced(function*(_workflow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        if (state.fiber) {
          yield* Fiber.interrupt(state.fiber)
        }
      }),
      resume(_workflow, executionId) {
        return resume(executionId)
      },
      // Untraced because activity execution is a retry-loop hot path.
      activityExecute: Effect.fnUntraced(function*(options) {
        const activity = options.activity
        const instance = yield* WorkflowInstance
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
        const activityInstance = WorkflowInstance.initial(instance.workflow, instance.executionId)
        activityInstance.interrupted = instance.interrupted
        return yield* activity.executeEncoded.pipe(
          Workflow.intoResult,
          Effect.provideService(WorkflowInstance, activityInstance),
          Effect.onExit((exit) => {
            state.exit = exit
            return Effect.void
          })
        )
      }),
      poll: (_workflow, executionId) =>
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
      // Untraced because deferred polling is a workflow scheduler hot path.
      deferredResult: Effect.fnUntraced(function*(deferred) {
        const instance = yield* WorkflowInstance
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
      scheduleClock: (workflow, options) =>
        engine.deferredDone(options.clock.deferred, {
          workflowName: workflow._tag,
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

const toJsonExit = Exit.map((value: any) => value ?? null)
