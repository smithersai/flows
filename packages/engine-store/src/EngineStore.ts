/**
 * Durable `FlowEngine.Encoded` composition over `@smithers/journal`.
 *
 * Governing designs: `docs/specs/Concepts/Run Ownership.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { type Activity, Flow, FlowEngine } from "@smithers/engine"
import { AttemptStore, CacheStore, Journal, type Ownership, RunStore } from "@smithers/journal"
import { Jj } from "@smithers/kernel"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { randomUUID } from "node:crypto"
import type * as DurableEngineState from "./DurableEngineState.ts"
import * as ActivityPersistence from "./internal/ActivityPersistence.ts"
import * as DeferredPersistence from "./internal/DeferredPersistence.ts"
import * as RunDriver from "./internal/RunDriver.ts"
import * as StepBoundary from "./StepBoundary.ts"

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
  readonly isAlive?: (
    owner: Ownership.OwnerId
  ) => Effect.Effect<boolean>
}

type Requirements =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | DurableEngineState.DurableEngineState
  | Journal.Journal
  | Jj.Jj
  | RunStore.RunStore
  | Scope.Scope
  | StepBoundary.Service

/** @since 0.1.0 @category errors */
export class EngineCompositionError extends Schema.TaggedErrorClass<EngineCompositionError>()(
  "flows/engine-store/EngineCompositionError",
  {
    code: Schema.Literal("engine_not_composed"),
    message: Schema.String
  }
) {}

const isBoundaryMetadata = Schema.is(StepBoundary.Descriptor)

const ownerId = (hostId: string): Ownership.OwnerId => ({
  hostId,
  pid: process.pid,
  nonce: randomUUID()
})

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
): Effect.Effect<FlowEngine.FlowEngine["Service"], never, Requirements> =>
  Effect.gen(function*() {
    const owner = ownerId(options.owner.hostId)
    const attemptStore = yield* AttemptStore.AttemptStore
    const cacheStore = yield* CacheStore.CacheStore
    const journal = yield* Journal.Journal
    const jj = yield* Jj.Jj
    const runStore = yield* RunStore.RunStore
    const stepBoundary = yield* StepBoundary.StepBoundary

    const engine = yield* Deferred.make<FlowEngine.FlowEngine["Service"]>()
    const driver = yield* RunDriver.make({
      owner,
      journalSource: options.journalSource,
      isAlive: options.isAlive ?? (() => Effect.succeed(true)),
      engine: Deferred.await(engine)
    })
    const deferred = yield* DeferredPersistence.make({
      owner,
      journalSource: options.journalSource,
      scheduleResume: (flowName, executionId, reason) => driver.scheduleResume(flowName, executionId, reason)
    })

    const activityExecute = Effect.fn("FlowEngine.activityExecute")(function*(input: {
      readonly activity: Activity.Any
      readonly attempt: number
      readonly key: string
      readonly tier: ActivityPersistence.Tier
      readonly metadata: unknown
    }) {
      const parent = yield* FlowEngine.FlowInstance
      const instance = FlowEngine.FlowInstance.initial(
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
          : input.key
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
        Effect.provideService(FlowEngine.FlowInstance, instance),
        Effect.provideService(
          FlowEngine.FlowEngine,
          flowEngine
        ),
        Effect.provideService(AttemptStore.AttemptStore, attemptStore),
        Effect.provideService(CacheStore.CacheStore, cacheStore),
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(RunStore.RunStore, runStore),
        Effect.provideService(StepBoundary.StepBoundary, stepBoundary)
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
  FlowEngine.SnapshotBoundary | FlowEngine.FlowEngine,
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
    Layer.effect(FlowEngine.FlowEngine, make(options)),
    snapshotBoundary
  )
}
