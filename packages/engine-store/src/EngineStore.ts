/**
 * Durable `WorkflowEngine.Encoded` composition over `@flows/journal`.
 *
 * Governing designs: `docs/specs/Concepts/Run Ownership.md`,
 * `docs/specs/Concepts/Step Keys.md`, and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { AttemptStore, CacheStore, Journal, type Ownership, RunStore } from "@flows/journal"
import { Jj } from "@flows/kernel"
import { type Activity, Workflow, WorkflowEngine } from "@flows/workflow-engine"
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
): Effect.Effect<WorkflowEngine.WorkflowEngine["Service"], never, Requirements> =>
  Effect.gen(function*() {
    const owner = ownerId(options.owner.hostId)
    const attemptStore = yield* AttemptStore.AttemptStore
    const cacheStore = yield* CacheStore.CacheStore
    const journal = yield* Journal.Journal
    const jj = yield* Jj.Jj
    const runStore = yield* RunStore.RunStore
    const stepBoundary = yield* StepBoundary.StepBoundary

    const engine = yield* Deferred.make<WorkflowEngine.WorkflowEngine["Service"]>()
    const driver = yield* RunDriver.make({
      owner,
      journalSource: options.journalSource,
      isAlive: options.isAlive ?? (() => Effect.succeed(true)),
      engine: Deferred.await(engine)
    })
    const deferred = yield* DeferredPersistence.make({
      owner,
      journalSource: options.journalSource,
      scheduleResume: (workflowName, executionId, reason) => driver.scheduleResume(workflowName, executionId, reason)
    })

    const activityExecute = Effect.fn("WorkflowEngine.activityExecute")(function*(input: {
      readonly activity: Activity.Any
      readonly attempt: number
      readonly key: string
      readonly tier: ActivityPersistence.Tier
      readonly metadata: unknown
    }) {
      const parent = yield* WorkflowEngine.WorkflowInstance
      const instance = WorkflowEngine.WorkflowInstance.initial(
        parent.workflow,
        parent.executionId
      )
      const workflowEngine = yield* Deferred.await(engine)
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
        Workflow.intoResult,
        Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
        Effect.provideService(
          WorkflowEngine.WorkflowEngine,
          workflowEngine
        ),
        Effect.provideService(AttemptStore.AttemptStore, attemptStore),
        Effect.provideService(CacheStore.CacheStore, cacheStore),
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(RunStore.RunStore, runStore),
        Effect.provideService(StepBoundary.StepBoundary, stepBoundary)
      )
    })

    const encoded: WorkflowEngine.Encoded = {
      register: Effect.fn("WorkflowEngine.register")((workflow, execute) =>
        driver.register(workflow, execute).pipe(
          Effect.tap(() => deferred.sweepDue(workflow._tag))
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
      // exposes a committed event-driven wake subscription. The workflow
      // engine's suspension polling schedule remains the fallback.
    }
    const service = WorkflowEngine.makeUnsafe(encoded)
    yield* Deferred.succeed(engine, service)
    return service
  })

/**
 * Provides the durable workflow engine.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: Options
): Layer.Layer<
  WorkflowEngine.SnapshotBoundary | WorkflowEngine.WorkflowEngine,
  never,
  Requirements
> => {
  const snapshotBoundary = Layer.effect(
    WorkflowEngine.SnapshotBoundary,
    Effect.map(Jj.Jj, (jj) =>
      WorkflowEngine.SnapshotBoundary.of({
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
    Layer.effect(WorkflowEngine.WorkflowEngine, make(options)),
    snapshotBoundary
  )
}
