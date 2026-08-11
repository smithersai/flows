/**
 * Durable `FlowEngine.Encoded` composition over `@smthrs/journal`.
 *
 * Governing designs: `docs/specs/Concepts/Run Ownership.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import { type Activity, Flow, FlowRuntime } from "@smthrs/flow"
import { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "./DurableEngineState.ts"
import * as ActivityPersistence from "./internal/ActivityPersistence.ts"
import * as AttemptAdmission from "./internal/AttemptAdmission.ts"
import * as AttemptProbe from "./internal/AttemptProbe.ts"
import * as DeferredPersistence from "./internal/DeferredPersistence.ts"
import * as RunDriver from "./internal/RunDriver.ts"
import * as OwnerIdentity from "./OwnerIdentity.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * Engine-store construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly owner: {
    readonly hostId: string
  }
  readonly journalSource: string
  readonly isAlive: (
    owner: Ownership.OwnerId
  ) => Effect.Effect<boolean>
  /**
   * Redispatch policy for a durable clock whose fire failed. Defaults to
   * {@link DeferredPersistence.defaultFireRetryPolicy} — exponential from
   * 100ms, capped at 30s, forever. Same shape as the engine's
   * `suspendedRetryPolicy` option: the built-in behavior is the default, and
   * a deployment that wants a different backoff supplies one here rather than
   * patching the store.
   */
  readonly clockFireRetryPolicy?: Schedule.Schedule<unknown, unknown> | undefined
}

type Requirements =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | DurableEngineState.DurableEngineState
  | Journal.Journal
  | Jj.Jj
  | OwnerIdentity.OwnerIdentity
  | RunStore.RunStore
  | Scope.Scope
  | StepBoundary.Service

/**
 * A caller reached for the engine composition before one was built.
 *
 * It is the single `engine_not_composed` refusal rather than a null service:
 * the composition is assembled once at startup, so hitting this always means a
 * wiring mistake, and a named error says so at the call site instead of
 * failing later inside an unrelated operation.
 *
 * @since 0.1.0 @category errors
 */
export class EngineCompositionError extends Schema.TaggedErrorClass<EngineCompositionError>()(
  "flows/engine-store/EngineCompositionError",
  {
    code: Schema.Literal("engine_not_composed"),
    message: Schema.String
  }
) {}

const isBoundaryMetadata = Schema.is(FileBoundary)

/**
 * Constructs the production encoded composition.
 *
 * Registrations and active fibers are scoped in memory. Run identity, encoded
 * payload, results, deferred completions, clocks, activities, and ownership
 * are persisted by the supplied layers.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  options: Options
): Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, Requirements> =>
  Effect.gen(function*() {
    const ownerIdentity = yield* OwnerIdentity.OwnerIdentity
    const owner = yield* ownerIdentity.ownerId(options.owner.hostId)
    // One admission mutex per incarnation, shared by every dispatch this
    // store drives: `ActivityPersistence.make` runs per dispatch below, so a
    // per-make default would never contend and the same-key exclusion the
    // adoption evidence rests on (issues #102, #103) would silently vanish.
    const admission = AttemptAdmission.makeUnsafe()
    const attemptStore = yield* AttemptStore.AttemptStore
    const cacheStore = yield* CacheStore.CacheStore
    const journal = yield* Journal.Journal
    const jj = yield* Jj.Jj
    const runStore = yield* RunStore.RunStore
    const stepBoundary = yield* StepBoundary.StepBoundary
    /**
     * Both halves of the isolated-execution lane are OPTIONAL and resolved
     * here, at composition time, for the same reason every service above is:
     * `activityExecute` runs on the engine's fiber, which does not carry the
     * store's layer context, so anything the dispatch needs has to be captured
     * now and re-provided below. A composition without a sandbox keeps the
     * pre-existing behaviour — the body runs against the host directly — and
     * one without a dispatcher journals what a transaction queued without
     * sending it.
     */
    const workspaceSandbox = yield* Effect.serviceOption(WorkspaceSandbox.WorkspaceSandbox)
    const effectDispatcher = yield* Effect.serviceOption(WorkspaceSandbox.EffectDispatcher)
    const engineState = yield* DurableEngineState.DurableEngineState
    const attemptSurvivors = engineState.attemptSurvivors

    const engine = yield* Deferred.make<FlowRuntime.FlowRuntime["Service"]>()
    const driver = yield* RunDriver.make({
      owner,
      journalSource: options.journalSource,
      isAlive: options.isAlive,
      engine: Deferred.await(engine)
    })
    const deferred = yield* DeferredPersistence.make({
      owner,
      journalSource: options.journalSource,
      scheduleResume: (flowName, executionId, reason) => driver.scheduleResume(flowName, executionId, reason),
      fireRetryPolicy: options.clockFireRetryPolicy
    })

    const activityExecute = Effect.fn("FlowEngine.activityExecute")(function*(input: {
      readonly activity: Activity.Any
      readonly attempt: number
      readonly key: string
      readonly tier: Activity.Tier
      readonly metadata: unknown
    }) {
      const parent = yield* FlowRuntime.FlowInstance
      const instance = FlowEngine.makeInstance(
        parent.flow,
        parent.executionId
      )
      const flowEngine = yield* Deferred.await(engine)
      instance.interrupted = parent.interrupted
      return yield* ActivityPersistence.make({
        runId: parent.executionId,
        owner,
        sourceId: options.journalSource,
        execute: (activityInput) =>
          (activityInput.activity as Activity.Any).executeEncoded as Effect.Effect<unknown, unknown>,
        idempotencyKey: input.activity.idempotencyKey === undefined
          ? undefined
          : input.key,
        admission
      })({
        activity: input.activity,
        attempt: input.attempt,
        key: input.key,
        tier: input.tier,
        ...(isBoundaryMetadata(input.metadata)
          ? { metadata: input.metadata }
          : {})
      }).pipe(
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(
          FlowRuntime.FlowRuntime,
          flowEngine
        ),
        Effect.provideService(AttemptStore.AttemptStore, attemptStore),
        Effect.provideService(CacheStore.CacheStore, cacheStore),
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(RunStore.RunStore, runStore),
        Effect.provideService(StepBoundary.StepBoundary, stepBoundary),
        (dispatch) =>
          Option.isNone(workspaceSandbox)
            ? dispatch
            : Effect.provideService(dispatch, WorkspaceSandbox.WorkspaceSandbox, workspaceSandbox.value),
        (dispatch) =>
          Option.isNone(effectDispatcher)
            ? dispatch
            : Effect.provideService(dispatch, WorkspaceSandbox.EffectDispatcher, effectDispatcher.value)
      )
    })

    const encoded: FlowEngine.Encoded = {
      register: Effect.fn("FlowEngine.register")((flow, execute) =>
        driver.register(flow, execute).pipe(
          Effect.tap(() => deferred.sweepDue(flow._tag))
        )
      ),
      execute: driver.execute,
      poll: driver.poll,
      interrupt: driver.interrupt,
      interruptUnsafe: driver.interruptUnsafe,
      resume: driver.resume,
      activityExecute,
      // The durable schedule-to-close origin (issue #45): the first
      // attempt's persisted `startedAtMs` for the activity key. It lives in
      // the same `flows_attempts` rows that already restore the attempt
      // sequence across park/resume and process death, so the engine's
      // `expirationMs` budget is measured from the true first attempt
      // instead of restarting on every process.
      activityRetryOrigin: Effect.fnUntraced(function*(input: {
        readonly key: string
      }) {
        const parent = yield* FlowRuntime.FlowInstance
        const survivors = yield* AttemptProbe.probeAttempts(
          attemptStore,
          attemptSurvivors,
          parent.executionId,
          yield* Schema.decodeUnknownEffect(Sha256)(input.key).pipe(Effect.orDie)
        )
        return Option.map(survivors, ({ earliestStartedAtMs }) => earliestStartedAtMs)
      }),
      // The durable attempt counter (issue #59): the highest contiguous
      // persisted attempt for the key, so a resumed run replays failed
      // attempts under their original numbers instead of restarting at 1 —
      // the persisted failure is rethrown by `ActivityPersistence`, the
      // retry decision sees the true attempt count, and the backoff ladder
      // is not re-slept.
      activityLatestAttempt: Effect.fnUntraced(function*(input: {
        readonly key: string
      }) {
        const parent = yield* FlowRuntime.FlowInstance
        const survivors = yield* AttemptProbe.probeAttempts(
          attemptStore,
          attemptSurvivors,
          parent.executionId,
          yield* Schema.decodeUnknownEffect(Sha256)(input.key).pipe(Effect.orDie)
        )
        return Option.map(survivors, ({ latest }) => latest)
      }),
      deferredResult: deferred.deferredResult,
      deferredDone: deferred.deferredDone,
      scheduleClock: deferred.scheduleClock
      // TODO(piece-6): resumeSignal remains unimplemented until Journal Queue
      // exposes a committed event-driven wake subscription. The flow
      // engine's suspension polling schedule remains the fallback.
    }
    const service = FlowEngine.makeUnsafe(encoded)
    yield* Deferred.succeed(engine, service)
    return service
  })

/**
 * Provides the durable flow engine.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: Options
): Layer.Layer<
  FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime,
  never,
  Requirements
> => {
  const snapshotBoundary = Layer.effect(
    FlowEngine.SnapshotBoundary,
    Effect.map(Jj.Jj, (jj) =>
      FlowEngine.SnapshotBoundary.of({
        snapshot: Effect.fn("SnapshotBoundary.snapshot")(({ key, attempt }) =>
          jj.snapshot(`flows activity ${key} attempt ${attempt}`).pipe(
            Effect.orDie,
            Effect.map((snapshot) => snapshot.changeId)
          )
        ),
        restore: Effect.fn("SnapshotBoundary.restore")((snapshot) => jj.restore(snapshot as never).pipe(Effect.orDie)),
        diff: Effect.fn("SnapshotBoundary.diff")((snapshot, { key, attempt }) =>
          jj.snapshot(`flows activity ${key} attempt ${attempt} settled`).pipe(
            Effect.orDie,
            Effect.flatMap((current) => jj.diff(snapshot as never, current.changeId).pipe(Effect.orDie))
          )
        )
      }))
  )
  return Layer.merge(
    Layer.effect(FlowRuntime.FlowRuntime, make(options)),
    snapshotBoundary
  )
}
