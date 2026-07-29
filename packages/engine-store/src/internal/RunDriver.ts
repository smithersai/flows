/**
 * Claim-gated durable workflow run lifecycle.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 */
import { Journal, Ownership, RunCoordinator, RunStore } from "@flows/journal"
import { Workflow, WorkflowEngine } from "@flows/workflow-engine"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as JournalRecords from "./JournalRecords.ts"

/**
 * The persisted, versioned state carried by a durable run row.
 *
 * @since 0.1.0
 * @category models
 */
export interface PersistedState {
  readonly version: 1
  readonly workflowName: string
  readonly payload: unknown
  readonly parentExecutionId?: string | undefined
  readonly result?: unknown
  readonly cancellation?: {
    readonly interruptedAtMs: number
  } | undefined
}

const PersistedStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  workflowName: Schema.String,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  cancellation: Schema.optional(Schema.Struct({
    interruptedAtMs: Schema.Number
  }))
})

const PersistedStateJson = Schema.fromJsonString(PersistedStateSchema)

/**
 * Dependencies for the run driver.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly owner: Ownership.OwnerId
  readonly journalSource: string
  readonly isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean>
  readonly engine: Effect.Effect<WorkflowEngine.WorkflowEngine["Service"]>
}

/**
 * Claim-gated operations composed into the encoded workflow engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly register: WorkflowEngine.Encoded["register"]
  readonly execute: WorkflowEngine.Encoded["execute"]
  readonly poll: WorkflowEngine.Encoded["poll"]
  readonly interrupt: WorkflowEngine.Encoded["interrupt"]
  readonly interruptUnsafe: WorkflowEngine.Encoded["interruptUnsafe"]
  readonly resume: WorkflowEngine.Encoded["resume"]
  readonly scheduleResume: (
    workflowName: string,
    executionId: string,
    reason: "deferred" | "clock" | "parent" | "operator"
  ) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<string>>
}

interface Registration {
  readonly workflow: Workflow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine>
}

const snapshot = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const samePayload = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const withoutResult = (state: PersistedState): PersistedState => {
  const { cancellation: _, result: __, ...rest } = state
  return rest
}

/**
 * Constructs a scoped run driver.
 *
 * Every start and wake enters the same keyed coordinator and then the same
 * exact-snapshot claim/activation path.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  dependencies: Dependencies
): Effect.Effect<Service, never, Journal.Journal | RunStore.RunStore | Scope.Scope> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const store = yield* RunStore.RunStore
    const registrations = new Map<string, Registration>()
    const liveInstances = new Map<string, WorkflowEngine.WorkflowInstance["Service"]>()

    const encodeState = (state: PersistedState): Effect.Effect<string> =>
      Schema.encodeEffect(PersistedStateJson)(state).pipe(Effect.orDie)

    const decodeState = (stateJson: string): Effect.Effect<PersistedState> =>
      Schema.decodeUnknownEffect(PersistedStateJson)(stateJson).pipe(Effect.orDie)

    const emitDecision = (
      runId: string,
      payload: unknown
    ): Effect.Effect<void> =>
      journal.emit(
        JournalRecords.runDecision({
          runId,
          sourceId: dependencies.journalSource
        }, payload)
      ).pipe(Effect.asVoid, Effect.orDie)

    const abandon = (runId: string, claimedAtMs: number): Effect.Effect<void> =>
      store.abandonClaim(runId, dependencies.owner, claimedAtMs).pipe(
        Effect.asVoid,
        Effect.orDie
      )

    const claimAndActivate = (
      row: RunStore.RunRow
    ): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
          return false
        }

        const expected = snapshot(row)
        const nowMs = yield* Clock.currentTimeMillis
        let claim: RunStore.ClaimOutcome

        if (row.status === "running") {
          if (
            row.owner === null ||
            row.heartbeatAtMs === null ||
            row.heartbeatAtMs >= nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)
          ) {
            return false
          }
          if (yield* dependencies.isAlive(row.owner)) {
            yield* emitDecision(row.runId, {
              decision: "steal-refused-owner-alive",
              expectedOwner: row.owner,
              heartbeatAtMs: row.heartbeatAtMs
            })
            return false
          }
          claim = yield* store.steal(
            row.runId,
            expected,
            dependencies.owner,
            nowMs,
            {
              expectedOwner: row.owner,
              checkedAtMs: nowMs,
              kind: row.owner.hostId === dependencies.owner.hostId
                ? "same-host-pid-dead"
                : "cross-host-unreachable-stale"
            }
          ).pipe(Effect.orDie)
        } else {
          claim = yield* store.claim(
            row.runId,
            expected,
            dependencies.owner,
            nowMs
          ).pipe(Effect.orDie)
        }

        if (claim._tag !== "Claimed") {
          yield* emitDecision(row.runId, {
            decision: "claim-lost",
            outcome: claim._tag,
            expected
          })
          return false
        }

        const activation = yield* store.activate(
          row.runId,
          dependencies.owner,
          claim.claimedAtMs,
          expected
        ).pipe(Effect.orDie)
        if (activation._tag !== "Activated") {
          yield* abandon(row.runId, claim.claimedAtMs)
          yield* emitDecision(row.runId, {
            decision: "activation-lost",
            outcome: activation._tag,
            expected
          })
          return false
        }

        yield* emitDecision(row.runId, {
          decision: row.status === "running" ? "stolen-and-activated" : "claimed-and-activated",
          previousStatus: row.status,
          owner: dependencies.owner
        })
        return true
      })

    const cancelOwned = (
      runId: string,
      state: PersistedState
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const interruptedAtMs = yield* Clock.currentTimeMillis
        const stateJson = yield* encodeState({
          ...withoutResult(state),
          cancellation: { interruptedAtMs }
        })
        const transitioned = yield* store.transitionOwned(
          runId,
          dependencies.owner,
          "cancelled",
          stateJson
        ).pipe(Effect.orDie)
        if (transitioned._tag !== "Transitioned") return
        const receipt = yield* journal.emit(
          JournalRecords.interrupted({
            runId,
            sourceId: dependencies.journalSource
          }, {
            outcome: "cancelled",
            interruptedAtMs,
            owner: dependencies.owner
          })
        ).pipe(Effect.orDie)
        if (receipt._tag !== "Dropped") {
          yield* journal.flush.pipe(Effect.orDie)
        }
      })

    const coordinatorDeferred = yield* Deferred.make<RunCoordinator.RunCoordinator<string, never>>()

    const drive = (executionId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const initial = yield* store.get(executionId).pipe(
          Effect.catch((error) =>
            error.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.die(error)
          )
        )
        if (initial === undefined) return

        const state = yield* decodeState(initial.stateJson)
        const registration = registrations.get(state.workflowName)
        if (registration === undefined) return
        if (!(yield* claimAndActivate(initial))) return

        const activeState = withoutResult(state)
        const cleared = yield* store.transitionOwned(
          executionId,
          dependencies.owner,
          "running",
          yield* encodeState(activeState)
        ).pipe(Effect.orDie)
        if (cleared._tag !== "Transitioned") return

        const payload = yield* (Schema.decodeUnknownEffect(
          Schema.toCodecJson(registration.workflow.payloadSchema)
        )(activeState.payload).pipe(Effect.orDie) as Effect.Effect<unknown>)
        const instance = WorkflowEngine.WorkflowInstance.initial(
          registration.workflow,
          executionId
        )
        liveInstances.set(executionId, instance)
        const workflowEngine = yield* dependencies.engine

        const result = yield* Effect.scoped(
          Effect.raceFirst(
            registration.execute(payload as object, executionId).pipe(
              Workflow.intoResult,
              Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
              Effect.provideService(WorkflowEngine.WorkflowEngine, workflowEngine)
            ),
            Ownership.heartbeatLoop(executionId, dependencies.owner).pipe(
              Effect.provideService(RunStore.RunStore, store)
            )
          )
        ).pipe(
          Effect.onInterrupt(() => cancelOwned(executionId, activeState)),
          Effect.ensuring(Effect.sync(() => liveInstances.delete(executionId)))
        )

        const encodedResult = yield* (Schema.encodeEffect(
          Schema.toCodecJson(Workflow.Result({
            success: registration.workflow.successSchema,
            error: registration.workflow.errorSchema
          }))
        )(result).pipe(Effect.orDie) as Effect.Effect<unknown>)
        const nextState: PersistedState = { ...activeState, result: encodedResult }
        const status: RunStore.RunStatus = result._tag === "Suspended"
          ? "suspended"
          : Exit.isSuccess(result.exit)
          ? "completed"
          : "failed"
        const transitioned = yield* store.transitionOwned(
          executionId,
          dependencies.owner,
          status,
          yield* encodeState(nextState)
        ).pipe(Effect.orDie)
        if (transitioned._tag !== "Transitioned") return

        yield* emitDecision(executionId, {
          decision: "transitioned",
          status,
          owner: dependencies.owner
        })
        if (
          status !== "suspended" &&
          activeState.parentExecutionId !== undefined
        ) {
          const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
          yield* activeCoordinator.wake(activeState.parentExecutionId)
        }
      })

    const coordinator = yield* RunCoordinator.make<string, never, never>({
      drain: drive
    })
    yield* Deferred.succeed(coordinatorDeferred, coordinator)

    const ensureRun = (
      workflow: Workflow.Any,
      options: {
        readonly executionId: string
        readonly payload: object
        readonly parent?: WorkflowEngine.WorkflowInstance["Service"] | undefined
      }
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const payload = yield* (Schema.encodeEffect(
          Schema.toCodecJson(workflow.payloadSchema)
        )(
          options.payload
        ).pipe(Effect.orDie) as Effect.Effect<unknown>)
        const state: PersistedState = {
          version: 1,
          workflowName: workflow._tag,
          payload,
          ...(options.parent === undefined
            ? {}
            : { parentExecutionId: options.parent.executionId })
        }
        const created = yield* store.create(
          options.executionId,
          yield* encodeState(state)
        ).pipe(Effect.exit)
        if (Exit.isSuccess(created)) return

        const failure = Option.getOrThrow(Exit.findErrorOption(created))
        if (!(failure instanceof RunStore.RunStoreError) || failure.code !== "constraint") {
          return yield* Effect.die(failure)
        }
        const existing = yield* store.get(options.executionId).pipe(Effect.orDie)
        const persisted = yield* decodeState(existing.stateJson)
        if (
          persisted.workflowName !== workflow._tag ||
          !samePayload(persisted.payload, payload)
        ) {
          return yield* Effect.die(
            new Error(
              `execution ${options.executionId} already belongs to a different workflow tag or encoded payload`
            )
          )
        }
      })

    const poll: Service["poll"] = Effect.fn("WorkflowEngine.poll")((workflow, executionId) =>
      store.get(executionId).pipe(
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeed(undefined)
            : Effect.die(error)
        ),
        Effect.flatMap((row) => {
          if (row === undefined) return Effect.succeedNone
          return decodeState(row.stateJson).pipe(
            Effect.flatMap((state) => {
              if (
                state.workflowName !== workflow._tag ||
                state.result === undefined
              ) {
                return Effect.succeedNone
              }
              return (Schema.decodeUnknownEffect(
                Schema.toCodecJson(Workflow.Result({
                  success: workflow.successSchema,
                  error: workflow.errorSchema
                }))
              )(state.result).pipe(
                Effect.orDie,
                Effect.map(Option.some)
              ) as Effect.Effect<Option.Option<Workflow.Result<unknown, unknown>>>)
            })
          )
        })
      )
    )

    const execute: Service["execute"] = Effect.fn("WorkflowEngine.execute")(
      function*<const Discard extends boolean>(
        workflow: Workflow.Any,
        options: {
          readonly executionId: string
          readonly payload: object
          readonly discard: Discard
          readonly parent?: WorkflowEngine.WorkflowInstance["Service"] | undefined
        }
      ) {
        if (!registrations.has(workflow._tag)) {
          return yield* Effect.die(
            new Error(`Workflow ${workflow._tag} is not registered`)
          )
        }
        yield* ensureRun(workflow, options)
        yield* coordinator.run(options.executionId)
        if (options.discard) return undefined as Discard extends true ? void : never
        const result = yield* poll(workflow, options.executionId)
        return Option.getOrElse(result, () => new Workflow.Suspended({})) as Discard extends true ? void
          : Workflow.Result<unknown, unknown>
      }
    )

    const interrupt = Effect.fn("WorkflowEngine.interrupt")((
      _workflow: Workflow.Any,
      executionId: string
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const instance = liveInstances.get(executionId)
        if (instance !== undefined) instance.interrupted = true
      }).pipe(Effect.andThen(coordinator.interrupt(executionId)))
    )

    const scheduleResume: Service["scheduleResume"] = Effect.fn("WorkflowEngine.scheduleResume")((
      workflowName,
      executionId,
      reason
    ) =>
      Effect.gen(function*() {
        const row = yield* store.get(executionId).pipe(
          Effect.catch((error) =>
            error.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.die(error)
          )
        )
        if (row === undefined) return
        const state = yield* decodeState(row.stateJson)
        if (state.workflowName !== workflowName) return
        yield* emitDecision(executionId, {
          decision: "wake-scheduled",
          reason
        })
        yield* coordinator.wake(executionId)
      })
    )

    return {
      register: Effect.fn("WorkflowEngine.register")((workflow, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const registration = { workflow, execute: handler }
            registrations.set(workflow._tag, registration)
            return registration
          }),
          (registration) =>
            Effect.sync(() => {
              if (registrations.get(workflow._tag) === registration) {
                registrations.delete(workflow._tag)
              }
            })
        ).pipe(Effect.asVoid)
      ),
      execute,
      poll,
      interrupt,
      interruptUnsafe: Effect.fn("WorkflowEngine.interruptUnsafe")(interrupt),
      resume: Effect.fn("WorkflowEngine.resume")((workflow, executionId) =>
        scheduleResume(workflow._tag, executionId, "operator").pipe(
          Effect.andThen(coordinator.run(executionId))
        )
      ),
      scheduleResume,
      active: Effect.fn("WorkflowEngine.active")(() => coordinator.active)()
    }
  })
