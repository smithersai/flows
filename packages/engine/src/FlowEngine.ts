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
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import * as Scope from "effect/Scope"
import * as Activity from "./Activity.ts"
import type { DurableClock } from "./DurableClock.ts"
import type * as DurableDeferred from "./DurableDeferred.ts"
import * as Flow from "./Flow.ts"
import * as RetryPolicy from "./RetryPolicy.ts"
import * as StepIdentity from "./StepIdentity.ts"

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
 * `@smithers/engine-store`'s `DurableEngineState.recordRunParent`, which
 * inserts the durable parent edge and walks the parent chain in O(depth)
 * inside one storage transaction, rolling back on a hit; the error is
 * declared here because it is part of the `execute` contract this package
 * owns.
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
      readonly nextOrdinal: (scope: string) => number
      readonly snapshots: Map<string, unknown>
      /**
       * Allocation scopes with a keyless dispatch currently in flight
       * (issue #111). Keyless invocations of one declaration are
       * allocation-ordered, so two in flight at once would take their
       * ordinals from the fiber schedule and a replay could swap their
       * recorded outcomes undetected; the engine refuses the second dispatch
       * instead.
       */
      readonly keylessInFlight: Set<string>
    }
  }
>()("effect/flow/FlowEngine/FlowInstance") {
  static initial(
    flow: Flow.Any,
    executionId: string
  ): FlowInstance["Service"] {
    // Ordinals are counted per allocation scope, not per run: the engine
    // scopes activity dispatches by activity name so a permuted fiber
    // interleaving cannot renumber them across a replay (issue #73).
    const ordinals = new Map<string, number>()
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
   *
   * `Option.none()` means no attempt row for `key` survives at all (for
   * example a retention job pruned every attempt). The engine then falls
   * back to the current clock — restarting the budget rather than failing
   * the run, because turning benign retention pruning into spurious
   * failures is worse than granting a fresh window — and logs a warning so
   * the restarted budget is observable (issue #69). Drivers are expected to
   * keep `Option.some` as long as any attempt row survives, using the
   * earliest surviving row when attempt 1 itself was pruned.
   */
  readonly activityRetryOrigin?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<number>, never, FlowInstance>)
    | undefined
  /**
   * The highest persisted attempt number for `key`, when attempts survive.
   *
   * Durable drivers implement it so the attempt counter resumes from the
   * persisted sequence after process death (issue #59): a replayed failed
   * attempt keeps its original attempt number, the backoff ladder is not
   * re-slept from attempt 1, and a persisted `nonRetryable` failure is
   * decided against the original attempt instead of re-dispatching.
   */
  readonly activityLatestAttempt?:
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
 * boundary mode yields a different key and therefore a cache miss. The key
 * is only half of Skyframe's dirty→recheck→rebuild model, though: these
 * digests are caller-declared, so before a sealed hit is served the store
 * re-measures them through `StepBoundary.prepare` and refuses a hit whose
 * declaration no longer matches the host (issue #90). Metadata of any other
 * shape stays out of the key.
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

/**
 * Folds the resolved environment into a content identity (issue #75).
 *
 * Layers and capabilities are engine-resolved material a caller must not be
 * able to opt out of — the same argument the boundary descriptor rests on
 * (issue #57) — so the caller's own declarations are kept and the
 * environment's are added on top. The empty environment is a no-op, so an
 * undeclared composition keeps the identity it had.
 */
const withEnvironment = (
  identity: StepKey.ContentIdentity,
  environment: Activity.ContentEnvironment
): StepKey.ContentIdentity => {
  if (environment.layers.length === 0 && Object.keys(environment.capabilities).length === 0) {
    return identity
  }
  // A capability group declared by both sides unions rather than replaces
  // (issue #89): an object spread let the environment's patterns overwrite
  // the caller's, so two activities declaring distinct patterns under a
  // shared group name hashed identically — a cross-run cache-key collision
  // in the code path whose purpose is preventing them. `StepKey.content`
  // sorts and dedupes within each group, so concatenation is canonical.
  const capabilities: Record<string, ReadonlyArray<string>> = { ...identity.capabilities }
  for (const [group, patterns] of Object.entries(environment.capabilities)) {
    const declared = capabilities[group]
    capabilities[group] = declared === undefined ? patterns : [...declared, ...patterns]
  }
  return {
    ...identity,
    layers: [...identity.layers, ...environment.layers],
    capabilities
  }
}

/**
 * The ordinal allocation scope of an activity dispatch — its stable
 * declaration identity (issue #85), derived by the one canonical path in
 * `StepIdentity` (issue #101).
 *
 * The activity name always contributes (issue #73), and a declared
 * `idempotencyKey` refines the scope further — the string form and the
 * object `ContentIdentity` form both, through the same canonicalization:
 * two concurrent invocations of one activity name with distinguishable
 * inputs declare distinct keys, so each owns its own counter and a replay
 * that reverses fiber-arrival order can never hand one invocation the
 * other's recorded outcome. Refining only the string form left object-keyed
 * activities on the name-only counter and exposed to exactly that swap.
 * Without a declared key, invocations of one name share a counter and
 * remain allocation-ordered — indistinguishable declarations have no
 * material to order them by.
 */
const ordinalScope = (activity: Activity.Any): string =>
  StepIdentity.allocationScope({
    kind: "activity",
    name: activity.name,
    idempotency: activity.idempotencyKey
  })

/**
 * A deterministic JSON form of an activity's declared success and error
 * schemas, derived from the schema ASTs through effect's stable
 * `SchemaRepresentation` document form. Folded into string-form sealed keys
 * so a changed declaration misses instead of decoding a stale cached row
 * under the new schema (issue #120).
 */
const declarationDigest = (activity: Activity.AnyWithProps): unknown => ({
  success: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(activity.successSchema.ast)),
  error: SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(activity.errorSchema.ast))
})

const activityKey = (
  activity: Activity.AnyWithProps,
  executionId: string,
  ordinal: number,
  environment: Activity.ContentEnvironment,
  scope: string
): string => {
  if (activity.tier === "sealed" && activity.idempotencyKey !== undefined) {
    // Skyframe's SkyKey is (functionName, argument): a string idempotencyKey
    // is namespaced by the activity name so two distinct activities sharing an
    // idempotency string can never collide and replay each other's outcomes,
    // and the declared success/error schemas are folded in so the body is the
    // *compiled declaration* the step-key spec requires — a schema change
    // must miss rather than replay a stale row decoded under the new schema
    // (issue #120). The object-form `ContentIdentity` stays caller-owned (no
    // name and no schema material folded in) as the explicit, documented
    // escape hatch for rename- and refactor-stable identity. Note: folding
    // the declaration changes the digest of every persisted string-key row
    // from before this fix; those keys were unsafe to replay across schema
    // changes, so the break is intentional (same precedent as the
    // name-namespacing fix).
    const identity: StepKey.ContentIdentity = typeof activity.idempotencyKey === "string"
      ? {
        body: {
          activity: activity.name,
          idempotencyKey: activity.idempotencyKey,
          declaration: declarationDigest(activity)
        },
        inputs: {},
        layers: [],
        capabilities: {}
      }
      : activity.idempotencyKey
    // The cacheability-gating boundary descriptor is content identity
    // (issue #25): a changed read set, write set, or boundary mode must miss
    // rather than replay a stale cross-run cache entry. Both key forms fold
    // it through this one path — the caller-owned `ContentIdentity` keeps
    // rename-stability (no name enters the digest) but can never opt out of
    // the read-set material `ActivityPersistence` gates cacheability on
    // (issue #57): the descriptor derived from `activity.metadata` overrides
    // any caller-supplied `hermetic` field.
    const hermetic = boundaryHermetic(activity.metadata)
    const scoped = withEnvironment(identity, environment)
    return Result.getOrThrow(StepKey.content(
      hermetic === undefined ? scoped : { ...scoped, hermetic }
    ))
  }
  // The ordinal is allocated from a counter scoped to this activity's
  // declaration identity and that scope is folded into the key as
  // `parentScope` (issues #73, #85). One per-run counter bumped in
  // fiber-arrival order made the identity of a compensable, irreversible, or
  // unsealed activity depend on scheduling: under `Effect.all` with
  // concurrency a replay could hand `chargeCard` the ordinal `sendEmail`
  // recorded and replay the wrong attempt rows, checkpoint, and outcome.
  // Per-identity counters are stable under any interleaving of distinct
  // declarations — distinct names, or one name with distinct declared
  // idempotency keys; the scope also keeps two identities from sharing the
  // number 1.
  return Result.getOrThrow(StepKey.ordinal({
    runId: executionId,
    parentScope: scope,
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
      // `Activity.retry` hands down an empty slot map rather than a number:
      // the ordinal can only be allocated here, where the activity — and so
      // its allocation scope — is known (issue #73). The slot is keyed by
      // scope so a retry block dispatching several distinct activities pins
      // each to its own ordinal (issue #84), reused across every attempt of
      // the sequence. Within one attempt the n-th dispatch of a scope takes
      // the n-th pinned ordinal (issue #100): a retry block may dispatch one
      // declaration several times, and each dispatch owns its own identity —
      // allocated on the attempt that first reaches it, replayed by position
      // on every later attempt.
      const scope = ordinalScope(activity)
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
      // Ordinal keys are run-local, so the environment is not their key
      // material; `activityKey` folds it into content keys only (issue #75).
      const environment = yield* Activity.CurrentContentEnvironment
      // `AnyWithProps` widening: `activityKey` needs the declared schemas so
      // the string-form sealed identity folds the compiled declaration
      // (issue #120); every activity built by `Activity.make` carries them,
      // only the `Schema.Constraint` type parameters resist the assignment.
      const key = activityKey(
        activity as unknown as Activity.AnyWithProps,
        instance.executionId,
        ordinal,
        environment,
        scope
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
      if (
        policy?.expirationMs !== undefined &&
        options.activityRetryOrigin !== undefined &&
        Option.isNone(durableOrigin)
      ) {
        // A durable driver that finds no surviving attempt row cannot bound
        // the schedule-to-close budget to the true first attempt. The engine
        // keeps the in-process fallback — failing the run outright would
        // turn benign attempt-row retention pruning into spurious failures —
        // but the restarted budget is worth a trace (issue #69).
        yield* Effect.logWarning(
          `FlowEngine.activityExecute: no durable retry origin for "${activity.name}"; the expirationMs budget restarts from the current clock`
        )
      }
      const retryStartMs = Option.isSome(durableOrigin)
        ? durableOrigin.value
        : yield* Clock.currentTimeMillis
      // Resume the durable attempt counter (issue #59): a persisted attempt
      // sequence keeps its numbering across process death, so replayed
      // failed attempts do not re-sleep the backoff ladder from attempt 1
      // and the retry decision below sees the true attempt count.
      const latestAttempt = options.activityLatestAttempt !== undefined
        ? yield* options.activityLatestAttempt({ key })
        : Option.none<number>()
      let currentAttempt = Option.isSome(latestAttempt) && latestAttempt.value > attempt
        ? latestAttempt.value
        : attempt
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
    }, (body, activity) =>
      // Keyless invocations of one declaration are allocation-ordered: with
      // two in flight at once the ordinals — and so the step keys, attempt
      // rows, and recorded outcomes — would be assigned by fiber arrival
      // order, and a crash-resume replaying the fibers in the opposite order
      // would silently hand one invocation the other's recorded outcome
      // (issue #111). There is no engine-visible input material to order
      // them by (inputs live in the execute closure), so the hazard is
      // refused up front — Temporal's nondeterminism error, moved to the
      // first run — and a declared idempotencyKey is the way out.
      Effect.gen(function*() {
        if (activity.idempotencyKey !== undefined) return yield* body
        const instance = yield* FlowInstance
        const inFlight = instance.activityState.keylessInFlight
        const scope = ordinalScope(activity)
        if (inFlight.has(scope)) {
          return yield* Effect.die(
            new Activity.ConcurrentKeylessDispatch({ activityName: activity.name })
          )
        }
        inFlight.add(scope)
        return yield* Effect.ensuring(
          body,
          Effect.sync(() => inFlight.delete(scope))
        )
      })),
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
