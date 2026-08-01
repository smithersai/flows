/**
 * Defines flow engine services and an in-memory implementation.
 *
 * `FlowEngine` registers flow handlers, runs executions, polls results,
 * resumes suspended runs, executes activities, stores durable deferred results,
 * and schedules durable clocks. `FlowInstance` holds the runtime state for
 * one flow run. The in-memory layer is useful for tests and local
 * development.
 *
 * @since 4.0.0
 */
import * as StepKey from "@smithers/keys/StepKey"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Activity from "./Activity.ts"
import type { DurableClock } from "./DurableClock.ts"
import type * as DurableDeferred from "./DurableDeferred.ts"
import * as Flow from "./Flow.ts"
import * as RetryPolicy from "./RetryPolicy.ts"

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
  readonly flow: Flow.Any
  readonly executionId: string
  readonly key: string
  readonly attempt: number
  readonly metadata: unknown
}

/**
 * Minimal host snapshot boundary required by compensable activities.
 *
 * TODO(piece-6): bind to @smithers/kernel Jj in @smithers/engine-store.
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
>()("flows/engine/SnapshotBoundary") {}

/**
 * Raised when executing a flow would close a cycle in the persisted
 * parent-execution chain — a child asking to execute an execution id that
 * already appears among its own ancestors.
 *
 * This is a **typed failure**, never a defect: the caller is expected to be
 * able to recover from it (see `docs/specs/Concepts/Run Ownership.md` and
 * `docs/architecture/implementation-status.md`). Detection itself lives in
 * `@smithers/engine-store`'s `internal/RunDriver.ts`, which walks the
 * persisted chain in O(depth); the error is declared here because it is part
 * of the `execute` contract this package owns.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowCycleDetected extends Schema.TaggedErrorClass<FlowCycleDetected>()(
  "flows/engine/FlowCycleDetected",
  {
    /** Stable public error code. */
    code: Schema.Literal("flow_cycle_detected"),
    /** Ordered execution ids from the cycle's target back to itself. */
    path: Schema.Array(Schema.String)
  }
) {}

/**
 * Service that represents flow runtimes, responsible for registering and
 * executing flows and coordinating activities, durable deferreds,
 * interrupts, resumes, and clocks.
 *
 * @category services
 * @since 4.0.0
 */
export class FlowEngine extends Context.Service<
  FlowEngine,
  {
    /**
     * Register a flow with the engine.
     */
    readonly register: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      R
    >(
      flow: Flow.Flow<Name, Payload, Success, Error>,
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
        | FlowEngine
        | FlowInstance
        | Flow.Execution<Name>
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
     * Execute a registered flow.
     */
    readonly execute: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      flow: Flow.Flow<Name, Payload, Success, Error>,
      options: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetryPolicy?:
          | RetryPolicy.RetryPolicy
          | undefined
      }
    ) => Effect.Effect<
      Discard extends true ? string : Success["Type"],
      Error["Type"] | FlowCycleDetected,
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Error["DecodingServices"]
    >

    /**
     * Poll the current status of a registered flow execution.
     */
    readonly poll: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top
    >(
      flow: Flow.Flow<Name, Payload, Success, Error>,
      executionId: string
    ) => Effect.Effect<
      Option.Option<Flow.Result<Success["Type"], Error["Type"]>>,
      never,
      Success["DecodingServices"] | Error["DecodingServices"]
    >

    /**
     * Interrupt a registered flow.
     */
    readonly interrupt: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Interrupts a registered flow unsafely, potentially ignoring
     * compensation finalizers and orphaning child flows.
     */
    readonly interruptUnsafe: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Resume a registered flow.
     */
    readonly resume: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Execute an activity from a flow.
     */
    readonly activityExecute: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(
      activity: Activity.Activity<Success, Error, R>,
      attempt: number
    ) => Effect.Effect<
      Flow.Result<Success["Type"], Error["Type"]>,
      never,
      | Success["DecodingServices"]
      | Error["DecodingServices"]
      | R
      | FlowInstance
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
      FlowInstance
    >

    /**
     * Set the result of a DurableDeferred, and then resume any waiting
     * flows.
     */
    readonly deferredDone: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>,
      options: {
        readonly flowName: string
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
      flow: Flow.Any,
      options: {
        readonly executionId: string
        readonly clock: DurableClock
      }
    ) => Effect.Effect<void>
  }
>()("effect/flow/FlowEngine") {}

/**
 * Service that contains flow runtime state for one execution.
 *
 * **When to use**
 *
 * Use to read or update flow execution, suspension, interruption,
 * lifetime, failure, and activity coordination state inside flow engine
 * internals.
 *
 * **Details**
 *
 * The service stores the execution ID, flow definition, long-lived scope,
 * suspension and interruption flags, the stored failure cause, and activity
 * coordination state for a single flow run.
 *
 * @category services
 * @since 4.0.0
 */
export class FlowInstance extends Context.Service<
  FlowInstance,
  {
    /**
     * The flow execution ID.
     */
    readonly executionId: string

    /**
     * The flow definition.
     */
    readonly flow: Flow.Any

    /**
     * A scope that represents the lifetime of the flow.
     *
     * It is only closed when the flow is completed.
     */
    readonly scope: Scope.Closeable

    /**
     * Whether the flow has requested to be suspended.
     */
    suspended: boolean

    /**
     * Whether the flow has requested to be interrupted.
     */
    interrupted: boolean

    /**
     * The waiting classification the flow declared for its next suspension
     * via {@link annotateWaiting}. Durable drivers read it when parking the
     * run so approval and quota waits (and their wake token) are
     * representable; when absent the driver derives `timer`/`event` from
     * durable state.
     */
    waiting: WaitingAnnotation | undefined

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
>()("effect/flow/FlowEngine/FlowInstance") {
  static initial(
    flow: Flow.Any,
    executionId: string
  ): FlowInstance["Service"] {
    let ordinal = 0
    return FlowInstance.of({
      executionId,
      flow,
      scope: Scope.makeUnsafe(),
      suspended: false,
      interrupted: false,
      waiting: undefined,
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
 * Low-level flow engine contract that works with encoded payloads and
 * results before `makeUnsafe` adds typed schema decoding and encoding.
 *
 * @category Encoded
 * @since 4.0.0
 */
export interface Encoded {
  readonly register: (
    flow: Flow.Any,
    execute: (
      payload: object,
      executionId: string
    ) => Effect.Effect<unknown, unknown, FlowInstance | FlowEngine>
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly execute: <const Discard extends boolean>(
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly payload: object
      readonly discard: Discard
      readonly parent?: FlowInstance["Service"] | undefined
    }
  ) => Effect.Effect<
    Discard extends true ? void : Flow.Result<unknown, unknown>,
    FlowCycleDetected
  >
  readonly poll: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>>
  readonly interrupt: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly interruptUnsafe: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly resume: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void>
  readonly resumeSignal?:
    | ((
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>)
    | undefined
  readonly activityExecute: (
    options: ActivityExecuteOptions
  ) => Effect.Effect<
    Flow.Result<unknown, unknown>,
    never,
    FlowInstance
  >
  /**
   * The durable wall-clock origin of an activity's retry sequence: the
   * persisted start time of the first attempt for `key`, when one exists.
   *
   * Durable drivers implement it so a `RetryPolicy.expirationMs`
   * (schedule-to-close) bound survives park/resume and process death
   * (issue #45); when absent the engine falls back to an in-process origin.
   */
  readonly activityRetryOrigin?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<number>, never, FlowInstance>)
    | undefined
  readonly deferredResult: (
    deferred: DurableDeferred.Any
  ) => Effect.Effect<
    Option.Option<Exit.Exit<unknown, unknown>>,
    never,
    FlowInstance
  >
  readonly deferredDone: (options: {
    readonly flowName: string
    readonly executionId: string
    readonly deferredName: string
    readonly exit: Exit.Exit<unknown, unknown>
  }) => Effect.Effect<void>
  readonly scheduleClock: (
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock
    }
  ) => Effect.Effect<void>
}

/**
 * Extracts the hermetic boundary descriptor from an activity's metadata when
 * it is shaped like one (`readSet` digests, `writeSet`, `boundaryMode`).
 *
 * The descriptor is what gates cross-run cacheability, so it must be part of
 * the content key (issue #25): a changed read-set digest, write set, or
 * boundary mode yields a different key and therefore a cache miss — the
 * Skyframe dirty→recheck→rebuild model collapsed into key-based
 * invalidation. Metadata of any other shape stays out of the key.
 */
const boundaryHermetic = (
  metadata: unknown
): NonNullable<StepKey.ContentIdentity["hermetic"]> | undefined => {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const candidate = metadata as {
    readonly readSet?: unknown
    readonly writeSet?: unknown
    readonly boundaryMode?: unknown
  }
  if (
    !Array.isArray(candidate.readSet) ||
    !Array.isArray(candidate.writeSet) ||
    (candidate.boundaryMode !== "hard" && candidate.boundaryMode !== "expected")
  ) {
    return undefined
  }
  const readSet: Array<{ readonly path: string; readonly digest: string }> = []
  for (const entry of candidate.readSet) {
    if (
      typeof entry !== "object" || entry === null ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      typeof (entry as { digest?: unknown }).digest !== "string"
    ) {
      return undefined
    }
    readSet.push(entry as { readonly path: string; readonly digest: string })
  }
  if (!candidate.writeSet.every((path) => typeof path === "string")) {
    return undefined
  }
  return {
    readSet,
    writeSet: candidate.writeSet,
    boundaryMode: candidate.boundaryMode
  }
}

const activityKey = (
  activity: Activity.Any,
  executionId: string,
  ordinal: number
): string => {
  if (activity.tier === "sealed" && activity.idempotencyKey !== undefined) {
    // Skyframe's SkyKey is (functionName, argument): a string idempotencyKey
    // is namespaced by the activity name so two distinct activities sharing an
    // idempotency string can never collide and replay each other's outcomes.
    // The object-form `ContentIdentity` stays caller-owned (no name folded in)
    // as the explicit escape hatch for rename-stable identity. Note: this
    // changes the digest of every persisted string-key row from before this
    // fix; those keys were unsafe to replay (cross-activity aliasing), so the
    // break is intentional.
    return Result.getOrThrow(StepKey.content(
      typeof activity.idempotencyKey === "string"
        ? {
          body: {
            activity: activity.name,
            idempotencyKey: activity.idempotencyKey
          },
          inputs: {},
          layers: [],
          capabilities: {},
          // The cacheability-gating boundary descriptor is content identity
          // (issue #25): a changed read set, write set, or boundary mode
          // must miss rather than replay a stale cross-run cache entry.
          ...(() => {
            const hermetic = boundaryHermetic(activity.metadata)
            return hermetic === undefined ? {} : { hermetic }
          })()
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
 * The waiting classification a flow can declare before suspending.
 *
 * Mirrors the durable store's waiting payload: `reason` is the supervisor
 * vocabulary (`approval`, `event`, `timer`, `quota`, or a plugin-defined
 * reason), `wakeAt` an absolute deadline, and `token` compare-and-swap
 * material a wake handler matches against.
 *
 * @category models
 * @since 0.1.0
 */
export interface WaitingAnnotation {
  readonly reason: string
  readonly wakeAt?: number | undefined
  readonly token?: string | undefined
}

/**
 * Declares how the flow is about to wait, so a durable driver parks the run
 * with that reason and token instead of the derived `timer`/`event` default.
 *
 * The annotation is scoped to the wait it precedes: once the awaited
 * deferred passes through with a persisted result — including replays after
 * the wait resolved — the declared classification is consumed, so a later
 * suspension parks under its own reason (and keeps its timer `wakeAt`)
 * instead of the stale one (issue #42).
 *
 * Call it immediately before awaiting the deferred that models the wait:
 *
 * ```ts
 * yield* FlowEngine.annotateWaiting({ reason: "approval", token: requestId })
 * const decision = yield* DurableDeferred.await(approvalGate)
 * ```
 *
 * @category combinators
 * @since 0.1.0
 */
export const annotateWaiting = (
  waiting: WaitingAnnotation | undefined
): Effect.Effect<void, never, FlowInstance> =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    instance.waiting = waiting
  })

/**
 * Builds a typed `FlowEngine` service from a low-level encoded
 * implementation.
 *
 * **When to use**
 *
 * Use when wiring a trusted low-level flow engine implementation into the
 * typed `FlowEngine` service.
 *
 * **Gotchas**
 *
 * The implementation must correctly persist, resume, and encode flow state.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeUnsafe = (options: Encoded): FlowEngine["Service"] =>
  FlowEngine.of({
    // Untraced because registering a flow recursively re-enters the engine.
    register: Effect.fnUntraced(function*(flow, execute) {
      const services = yield* Effect.context<FlowEngine>()
      yield* options.register(flow, (payload, executionId) =>
        Effect.suspend(() => execute(payload, executionId)).pipe(
          Effect.updateContext(
            (input) => Context.merge(services, input) as Context.Context<any>
          )
        ))
    }),
    // Untraced because flow execution recursively invokes child flows.
    execute: Effect.fnUntraced(function*<
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      self: Flow.Flow<Name, Payload, Success, Error>,
      opts: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetryPolicy?:
          | RetryPolicy.RetryPolicy
          | undefined
      }
    ) {
      const payload = opts.payload
      const executionId = opts.executionId
      const suspendedRetryPolicy = opts.suspendedRetryPolicy ?? RetryPolicy.defaultRetryPolicy
      yield* Effect.annotateCurrentSpan({ executionId })
      let result = Option.none<Flow.Result<Success["Type"], Error["Type"]>>()

      // link interruption with parent flow
      const parentInstance = yield* Effect.serviceOption(FlowInstance)
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
      }) as Effect.Effect<Flow.Result<Success["Type"], Error["Type"]>>

      if (opts.discard) {
        yield* run
        return executionId
      }

      if (Option.isSome(parentInstance)) {
        const wrapped = yield* Flow.wrapActivityResult(
          run,
          (result) => result._tag === "Suspended"
        )
        result = Option.some(wrapped)
        if (wrapped._tag === "Suspended") {
          return yield* Flow.suspend(parentInstance.value)
        }
        return yield* wrapped.exit
      }

      let resumeAttempt = 0
      // The expiration origin for the resume loop is in-process by design:
      // the loop itself only lives as long as this caller, and a restart
      // re-enters `execute` with a fresh budget. What must not happen is the
      // bound being silently inert (issue #45): `expirationMs` on the
      // suspended retry policy caps the wall-clock time this caller keeps
      // polling a suspended execution.
      const resumeStartMs = yield* Clock.currentTimeMillis
      while (true) {
        const wrapped = yield* run
        result = Option.some(wrapped)
        if (wrapped._tag === "Complete") {
          return yield* wrapped.exit as Exit.Exit<any>
        }
        // The resume delay is derived from the attempt count (data policy) so
        // backoff survives a restart.
        resumeAttempt = resumeAttempt + 1
        const elapsedMs = (yield* Clock.currentTimeMillis) - resumeStartMs
        const delay = yield* RetryPolicy.nextDelayEffect(
          suspendedRetryPolicy,
          resumeAttempt,
          { elapsedMs }
        )
        if (Option.isNone(delay)) {
          // Distinguish the wall-clock give-up from attempt exhaustion: the
          // delay is only elapsed-dependent when dropping `elapsedMs` would
          // have allowed another attempt.
          const expired = Option.isSome(
            RetryPolicy.nextDelay(suspendedRetryPolicy, resumeAttempt)
          )
          return yield* Effect.die(
            `${self._tag}.execute: suspendedRetryPolicy ${expired ? "expired" : "exhausted"}`
          )
        }
        const sleep = Effect.sleep(delay.value)
        yield* (options.resumeSignal === undefined
          ? sleep
          : Effect.raceFirst(sleep, options.resumeSignal(self, executionId)))
      }
    }),
    poll: options.poll,
    interrupt: options.interrupt,
    interruptUnsafe: options.interruptUnsafe,
    resume: options.resume,
    // Untraced because activity retries are a hot path within a flow run.
    activityExecute: Effect.fnUntraced(function*<
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(activity: Activity.Activity<Success, Error, R>, attempt: number) {
      const instance = yield* FlowInstance
      const currentOrdinal = yield* Activity.CurrentOrdinal
      const key = activityKey(
        activity,
        instance.executionId,
        currentOrdinal ?? instance.activityState.nextOrdinal()
      )
      const policy = activity.retryPolicy
      // Elapsed retry time for the policy's expiration bound. Durable
      // drivers persist the first attempt's start time alongside the attempt
      // row and expose it through `activityRetryOrigin`, so the
      // schedule-to-close budget survives park/resume and process death
      // (issue #45, mirroring Temporal's persisted expiration interval). The
      // in-process clock is the fallback for engines without durable
      // attempts.
      const durableOrigin = policy?.expirationMs !== undefined &&
          options.activityRetryOrigin !== undefined
        ? yield* options.activityRetryOrigin({ key })
        : Option.none<number>()
      const retryStartMs = Option.isSome(durableOrigin)
        ? durableOrigin.value
        : yield* Clock.currentTimeMillis
      let currentAttempt = attempt
      while (true) {
        if (
          activity.tier === "irreversible" &&
          currentAttempt > 1 &&
          activity.idempotencyKey === undefined
        ) {
          return yield* Effect.die(
            new Activity.IrreversibleRetryRequiresIdempotencyKey({
              activityName: activity.name,
              attempt: currentAttempt
            })
          )
        }
        const input: ActivityExecuteOptions = {
          activity,
          attempt: currentAttempt,
          key,
          tier: activity.tier,
          metadata: activity.metadata
        }
        let result: Flow.Result<unknown, unknown>
        if (activity.tier === "compensable") {
          const boundaryOption = yield* Effect.serviceOption(SnapshotBoundary)
          if (Option.isNone(boundaryOption)) {
            return yield* Effect.die(
              `Compensable activity "${activity.name}" requires SnapshotBoundary`
            )
          }
          const boundary = boundaryOption.value
          const boundaryOptions: SnapshotBoundaryOptions = {
            flow: instance.flow,
            executionId: instance.executionId,
            key,
            attempt: currentAttempt,
            metadata: activity.metadata
          }
          if (currentAttempt > 1 && instance.activityState.snapshots.has(key)) {
            yield* boundary.restore(
              instance.activityState.snapshots.get(key),
              boundaryOptions
            )
          }
          const snapshot = yield* boundary.snapshot(boundaryOptions)
          instance.activityState.snapshots.set(key, snapshot)
          result = yield* options.activityExecute(input).pipe(
            Effect.ensuring(Effect.asVoid(boundary.diff(snapshot, boundaryOptions))),
            Effect.provideService(Activity.CurrentAttempt, currentAttempt)
          )
        } else {
          result = yield* options.activityExecute(input).pipe(
            Effect.provideService(Activity.CurrentAttempt, currentAttempt)
          )
        }
        if (result._tag === "Suspended") {
          return result
        }
        // The engine's single retry decision point. The delay is derived from
        // the attempt count — persisted by durable engines and passed back in
        // on resume — so a backoff sequence survives process death.
        // nonRetryable classification is evaluated here and nowhere else.
        if (policy !== undefined && result.exit._tag === "Failure") {
          const failure = result.exit.cause.reasons.find(Cause.isFailReason)
          if (failure !== undefined) {
            const decision = yield* RetryPolicy.decideEffect(policy, {
              attempt: currentAttempt,
              error: failure.error,
              elapsedMs: (yield* Clock.currentTimeMillis) - retryStartMs
            })
            if (decision._tag === "RetryAfter") {
              yield* Effect.sleep(decision.delayMs)
              currentAttempt = currentAttempt + 1
              continue
            }
            if (decision.reason === "exhausted") {
              return new Flow.Complete({
                exit: Exit.die(
                  new RetryPolicy.RetryAttemptsExhausted({
                    activityName: activity.name,
                    attempt: currentAttempt,
                    maxAttempts: policy.maxAttempts ?? currentAttempt,
                    lastError: failure.error
                  })
                )
              })
            }
            if (decision.reason === "expired") {
              return new Flow.Complete({
                exit: Exit.die(
                  new RetryPolicy.RetryPolicyExpired({
                    activityName: activity.name,
                    attempt: currentAttempt,
                    // `expired` is only ever produced by a policy that
                    // declares `expirationMs`, so the bound is always present.
                    expirationMs: policy.expirationMs as number,
                    lastError: failure.error
                  })
                )
              })
            }
            // nonRetryable: fall through and propagate the original failure.
          }
        }
        const exit = yield* Effect.orDie(
          Schema.decodeEffect(activity.exitSchemaPartial)(toJsonExit(result.exit))
        )
        return new Flow.Complete({ exit })
      }
    }),
    // Untraced because the explicit span below carries deferred attributes.
    deferredResult: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>
      ) {
        const instance = yield* FlowInstance
        yield* Effect.annotateCurrentSpan({
          executionId: instance.executionId
        })
        const exit = yield* options.deferredResult(deferred)
        if (Option.isNone(exit)) {
          return Option.none()
        }
        // A persisted result means the annotated wait (if any) resolved: the
        // waiting annotation is consumed here so a replayed
        // `annotateWaiting` cannot classify a later, unrelated suspension
        // (issue #42).
        instance.waiting = undefined
        return Option.some(
          yield* Effect.orDie(
            Schema.decodeEffect(deferred.exitSchema)(toJsonExit(exit.value))
          ) as Effect.Effect<Exit.Exit<Success["Type"], Error["Type"]>>
        )
      },
      Effect.withSpan(
        "FlowEngine.deferredResult",
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
          readonly flowName: string
          readonly executionId: string
          readonly deferredName: string
          readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
        }
      ) {
        return yield* options.deferredDone({
          flowName: opts.flowName,
          executionId: opts.executionId,
          deferredName: opts.deferredName,
          exit: yield* Schema.encodeEffect(deferred.exitSchema)(
            opts.exit
          ) as Effect.Effect<Exit.Exit<unknown, unknown>>
        })
      },
      Effect.withSpan(
        "FlowEngine.deferredDone",
        (_, { deferredName, executionId }) => ({
          attributes: { name: deferredName, executionId }
        }),
        { captureStackTrace: false }
      )
    ),
    scheduleClock: Effect.fn("FlowEngine.scheduleClock")((flow, opts) =>
      options.scheduleClock(flow, opts).pipe(
        Effect.withSpan(
          "FlowEngine.scheduleClock",
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

/**
 * Layer that provides an in-memory `FlowEngine`.
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
export const layerMemory: Layer.Layer<FlowEngine> = Layer.effect(FlowEngine)(
  Effect.gen(function*() {
    const scope = yield* Effect.scope

    const flows = new Map<string, {
      readonly flow: Flow.Any
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, FlowInstance | FlowEngine>
      readonly scope: Scope.Scope
    }>()

    type ExecutionState = {
      readonly payload: object
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, FlowInstance | FlowEngine>
      readonly parent: string | undefined
      instance: FlowInstance["Service"]
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
      if (exit && exit._tag === "Success" && exit.value._tag === "Complete") {
        return
      } else if (state.fiber && !exit) {
        return
      }

      const entry = flows.get(state.instance.flow._tag)!
      const instance = FlowInstance.initial(state.instance.flow, state.instance.executionId)
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
        Effect.provideService(FlowInstance, instance),
        Effect.provideService(FlowEngine, engine),
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
            instance: FlowInstance.initial(flow, options.executionId),
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
        const instance = yield* FlowInstance
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
        const activityInstance = FlowInstance.initial(instance.flow, instance.executionId)
        activityInstance.interrupted = instance.interrupted
        return yield* activity.executeEncoded.pipe(
          Flow.intoResult,
          Effect.provideService(FlowInstance, activityInstance),
          Effect.onExit((exit) => {
            state.exit = exit
            return Effect.void
          })
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
        const instance = yield* FlowInstance
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

const toJsonExit = Exit.map((value: any) => value ?? null)
