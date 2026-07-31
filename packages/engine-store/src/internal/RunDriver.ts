/**
 * Claim-gated durable flow run lifecycle.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 */
import { Flow, FlowEngine } from "@smithers/engine"
import { Journal, Ownership, RunCoordinator, RunStore } from "@smithers/journal"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as JournalRecords from "./JournalRecords.ts"

/**
 * The persisted, versioned state carried by a durable run row.
 *
 * @since 0.1.0
 * @category models
 */
export interface PersistedState {
  readonly version: 1
  readonly flowName: string
  readonly payload: unknown
  readonly parentExecutionId?: string | undefined
  readonly result?: unknown
  readonly cancellation?: {
    readonly interruptedAtMs: number
  } | undefined
}

const PersistedStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  flowName: Schema.String,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
  cancellation: Schema.optional(Schema.Struct({
    interruptedAtMs: Schema.Number
  }))
})

const PersistedStateJson = Schema.fromJsonString(PersistedStateSchema)

/**
 * Raised when a flow (directly or through mutual ancestry) attempts to
 * execute an execution id that already appears in its own persisted
 * `parentExecutionId` chain.
 *
 * Detection walks the already-persisted parent chain from the requesting
 * parent upward — an O(depth) check, not a dependency-graph DFS — because
 * `parentExecutionId` is the only edge our runtime model can express.
 *
 * The class is declared by `@smithers/engine` (it is part of the `execute`
 * contract) and re-exported here for the detector's callers. See
 * `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 * @category errors
 */
export const FlowCycleDetected = FlowEngine.FlowCycleDetected

/**
 * @since 0.1.0
 * @category errors
 */
export type FlowCycleDetected = FlowEngine.FlowCycleDetected

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
  readonly engine: Effect.Effect<FlowEngine.FlowEngine["Service"]>
}

/**
 * Claim-gated operations composed into the encoded flow engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly register: FlowEngine.Encoded["register"]
  readonly execute: FlowEngine.Encoded["execute"]
  readonly poll: FlowEngine.Encoded["poll"]
  readonly interrupt: FlowEngine.Encoded["interrupt"]
  readonly interruptUnsafe: FlowEngine.Encoded["interruptUnsafe"]
  readonly resume: FlowEngine.Encoded["resume"]
  readonly scheduleResume: (
    flowName: string,
    executionId: string,
    reason: "deferred" | "clock" | "parent" | "operator"
  ) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<string>>
}

interface Registration {
  readonly flow: Flow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, FlowEngine.FlowInstance | FlowEngine.FlowEngine>
}

const snapshot = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const samePayload = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/**
 * Sentinel produced when the cancel-request poll observes a durable
 * cancellation before the flow settles.
 */
const cancelRequested = { _tag: "CancelRequested" } as const
type CancelRequested = typeof cancelRequested

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
): Effect.Effect<
  Service,
  never,
  DurableEngineState.DurableEngineState | Journal.Journal | RunStore.RunStore | Scope.Scope
> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const store = yield* RunStore.RunStore
    const engineState = yield* DurableEngineState.DurableEngineState
    const registrations = new Map<string, Registration>()
    const liveInstances = new Map<string, FlowEngine.FlowInstance["Service"]>()
    /**
     * Second-and-later parent edges for executions that already exist.
     *
     * The persisted `parentExecutionId` records only the first parent (the
     * creator); a diamond — `A executes C`, then `B executes C` — adds a
     * `C -> B` edge the row cannot carry. Those requesting edges are the ones
     * that produce the in-process mutual `coordinator.run` await, so they are
     * tracked here and walked by `detectCycle` alongside the persisted edge.
     * The map is rebuilt naturally on restart: re-driving `B` re-executes `C`
     * and re-records the edge before any new cycle can form.
     */
    const requestedParents = new Map<string, Set<string>>()

    const encodeState = (state: PersistedState): Effect.Effect<string> =>
      Schema.encodeEffect(PersistedStateJson)(state).pipe(Effect.orDie)

    const decodeState = (stateJson: string): Effect.Effect<PersistedState> =>
      Schema.decodeUnknownEffect(PersistedStateJson)(stateJson).pipe(Effect.orDie)

    /**
     * Run decisions are lifecycle records: they take the journal's durable
     * channel so a saturated lossy queue can never drop them (issue #10).
     * They stay ownerless because several decisions — `claim-lost`,
     * `steal-refused-owner-alive`, post-transition `transitioned` — are
     * legitimately recorded by a process that does not (or no longer does)
     * own the run; the ownership fence for these paths is the run-row CAS
     * that precedes each emit.
     */
    const emitDecision = (
      runId: string,
      payload: unknown
    ): Effect.Effect<void> =>
      journal.emitDurable(
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
        // A cancel can race the final poll after the run already parked
        // (park precedes the guarded terminal CAS). Clear the waiting row so
        // the terminally cancelled run never surfaces to a sweeper again
        // (issue #28); `waitingRuns`' status filter covers a crash landing
        // between the transition above and this wake.
        yield* engineState.wake(runId).pipe(Effect.asVoid)
        // Durable channel (issue #10): the interruption record must survive
        // the process exiting right after cancellation. Ownerless because the
        // `cancelled` transition above has already released ownership; the
        // fence is the transition CAS itself.
        yield* journal.emitDurable(
          JournalRecords.interrupted({
            runId,
            sourceId: dependencies.journalSource
          }, {
            outcome: "cancelled",
            interruptedAtMs,
            owner: dependencies.owner
          })
        ).pipe(Effect.orDie)
      })

    /**
     * Releases an interrupted run reclaimably instead of closing it
     * (issue #26). A drive-fiber interruption is not evidence of operator
     * cancellation — process shutdown closes the coordinator scope, and the
     * heartbeat loop self-interrupts on any heartbeat error — so the run
     * transitions back to `suspended` while the fence is still validly held,
     * leaving it claimable by any worker (Temporal worker-shutdown
     * semantics). On genuine fence loss the owned transition fails
     * harmlessly.
     */
    const releaseOwned = (
      runId: string,
      state: PersistedState
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const transitioned = yield* store.transitionOwned(
          runId,
          dependencies.owner,
          "suspended",
          yield* encodeState(withoutResult(state))
        ).pipe(Effect.orDie)
        if (transitioned._tag !== "Transitioned") return
        yield* emitDecision(runId, {
          decision: "interrupt-released",
          owner: dependencies.owner
        })
      })

    /**
     * Discriminates an interruption cause by durable state: only an
     * interruption backed by a recorded cancel request closes the run;
     * anything else releases it for reclaim (issue #26).
     */
    const settleInterrupted = (
      runId: string,
      state: PersistedState
    ): Effect.Effect<void> =>
      store.get(runId).pipe(
        Effect.map((row) => row.cancelRequestedAtMs !== null),
        Effect.catch(() => Effect.succeed(false)),
        Effect.flatMap((requested) =>
          requested ? cancelOwned(runId, state) : releaseOwned(runId, state)
        )
      )

    const coordinatorDeferred = yield* Deferred.make<RunCoordinator.RunCoordinator<string, never>>()

    /**
     * Observes a durably recorded cancellation request
     * (`RunStore.requestCancel` / `cancel_requested_at_ms`) from another
     * process. Polls on the heartbeat cadence — the request is unfenced, so
     * only the owner can act on it, and it must act within a poll interval
     * (issue #11). Completes when a request is observed; races against the
     * flow like the heartbeat loop.
     */
    const cancelPollLoop = (executionId: string): Effect.Effect<CancelRequested> =>
      Effect.gen(function*() {
        // Check-first: a request that raced in just before activation is
        // observed without waiting out a full heartbeat (issue #27).
        while (true) {
          const requested = yield* store.get(executionId).pipe(
            Effect.map((row) => row.cancelRequestedAtMs !== null),
            Effect.catch(() => Effect.succeed(false))
          )
          if (requested) return cancelRequested
          yield* Effect.sleep(Ownership.heartbeatInterval)
        }
      })

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
        const registration = registrations.get(state.flowName)
        if (registration === undefined) return
        if (!(yield* claimAndActivate(initial))) return

        const activeState = withoutResult(state)
        // The activation transition carries the cancel guard: a run whose
        // cancellation was durably requested while it was parked must cancel
        // here instead of re-executing flow side effects (issue #27).
        const cleared = yield* store.transitionOwned(
          executionId,
          dependencies.owner,
          "running",
          yield* encodeState(activeState),
          { cancelRequested: "absent" }
        ).pipe(Effect.orDie)
        if (cleared._tag === "GuardFailed") {
          return yield* cancelOwned(executionId, withoutResult(state))
        }
        if (cleared._tag !== "Transitioned") return
        // A run that re-enters execution is no longer waiting: clear any
        // parked waiting-reason payload (idempotent when none exists).
        yield* engineState.wake(executionId)

        const payload = yield* (Schema.decodeUnknownEffect(
          Schema.toCodecJson(registration.flow.payloadSchema)
        )(activeState.payload).pipe(Effect.orDie) as Effect.Effect<unknown>)
        const instance = FlowEngine.FlowInstance.initial(
          registration.flow,
          executionId
        )
        liveInstances.set(executionId, instance)
        const flowEngine = yield* dependencies.engine

        const result = yield* Effect.scoped(
          Effect.raceFirst(
            Effect.raceFirst(
              registration.execute(payload as object, executionId).pipe(
                Flow.intoResult,
                Effect.provideService(FlowEngine.FlowInstance, instance),
                Effect.provideService(FlowEngine.FlowEngine, flowEngine)
              ),
              Ownership.heartbeatLoop(executionId, dependencies.owner).pipe(
                Effect.provideService(RunStore.RunStore, store)
              )
            ),
            cancelPollLoop(executionId)
          )
        ).pipe(
          Effect.onInterrupt(() => settleInterrupted(executionId, activeState)),
          Effect.ensuring(Effect.sync(() => liveInstances.delete(executionId)))
        )
        if (result._tag === "CancelRequested") {
          return yield* cancelOwned(executionId, activeState)
        }

        const encodedResult = yield* (Schema.encodeEffect(
          Schema.toCodecJson(Flow.Result({
            success: registration.flow.successSchema,
            error: registration.flow.errorSchema
          }))
        )(result).pipe(Effect.orDie) as Effect.Effect<unknown>)
        const nextState: PersistedState = { ...activeState, result: encodedResult }
        const status: RunStore.RunStatus = result._tag === "Suspended"
          ? "suspended"
          : Exit.isSuccess(result.exit)
          ? "completed"
          : "failed"
        if (status === "suspended") {
          // Park while this process still owns the row (`park` is
          // owner-fenced; the suspended transition below releases
          // ownership). The reason is derived from durable state: a pending
          // clock row means a timer wake with a known deadline; anything
          // else waits on an external event (deferred completion). This is
          // what makes `waitingRuns` sweepers and the 0004 partial index
          // match real suspensions (issue #12).
          // A flow-declared classification (FlowEngine.annotateWaiting) wins:
          // it is the only way an approval or quota wait — and its wake
          // token — reaches the parked row (issue #31). The durable-state
          // derivation stays the fallback.
          const declared = instance.waiting
          const pendingClocks = yield* engineState.pendingClocks({ executionId })
          const waiting: DurableEngineState.Waiting = declared !== undefined
            ? declared
            : pendingClocks.length > 0
            ? {
              reason: "timer",
              wakeAt: Math.min(...pendingClocks.map((clock) => clock.dueAtMs))
            }
            : { reason: "event" }
          yield* engineState.park(executionId, waiting, dependencies.owner)
        }
        // Finalize is guarded on `cancel_requested_at_ms` inside the same
        // CAS: a cancellation request that raced past the last poll turns
        // the terminal transition into GuardFailed, and the run cancels
        // instead of finalizing (issue #11).
        const transitioned = yield* store.transitionOwned(
          executionId,
          dependencies.owner,
          status,
          yield* encodeState(nextState),
          { cancelRequested: "absent" }
        ).pipe(Effect.orDie)
        if (transitioned._tag === "GuardFailed") {
          return yield* cancelOwned(executionId, activeState)
        }
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

    /**
     * Delivers cancellation to parked runs (issue #27). A suspended run has
     * no owner and therefore no cancel poll, so `requestCancel` against it
     * is write-only until something re-drives the run — a run parked on a
     * deferred that never completes could otherwise never be cancelled. The
     * sweep lists parked rows, and wakes any whose cancel was durably
     * requested; the re-activation cancel guard then closes the run without
     * re-executing the flow.
     */
    const sweepCancelRequested: Effect.Effect<void> = Effect.gen(function*() {
      const parked = yield* engineState.waitingRuns()
      for (const waiting of parked) {
        const row = yield* store.get(waiting.runId).pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        if (
          row !== undefined &&
          row.status === "suspended" &&
          row.cancelRequestedAtMs !== null
        ) {
          yield* coordinator.wake(row.runId)
        }
      }
    })
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(Ownership.heartbeatInterval).pipe(
          Effect.andThen(sweepCancelRequested)
        )
      )
    )

    const ensureRun = (
      flow: Flow.Any,
      options: {
        readonly executionId: string
        readonly payload: object
        readonly parent?: FlowEngine.FlowInstance["Service"] | undefined
      }
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const payload = yield* (Schema.encodeEffect(
          Schema.toCodecJson(flow.payloadSchema)
        )(
          options.payload
        ).pipe(Effect.orDie) as Effect.Effect<unknown>)
        const state: PersistedState = {
          version: 1,
          flowName: flow._tag,
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
          persisted.flowName !== flow._tag ||
          !samePayload(persisted.payload, payload)
        ) {
          return yield* Effect.die(
            new Error(
              `execution ${options.executionId} already belongs to a different flow tag or encoded payload`
            )
          )
        }
        // The row already exists, so `store.create` never records this
        // request's parent. Record the extra edge (a diamond's second
        // parent) so `detectCycle` can traverse it.
        if (
          options.parent !== undefined &&
          persisted.parentExecutionId !== options.parent.executionId
        ) {
          const parents = requestedParents.get(options.executionId) ?? new Set<string>()
          parents.add(options.parent.executionId)
          requestedParents.set(options.executionId, parents)
        }
      })

    const parentsOf = (executionId: string): Effect.Effect<ReadonlyArray<string>> =>
      store.get(executionId).pipe(
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeed(undefined)
            : Effect.die(error)
        ),
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.succeed(undefined)
            : decodeState(row.stateJson).pipe(Effect.map((state) => state.parentExecutionId))
        ),
        Effect.map((persisted) => {
          const parents = new Set(requestedParents.get(executionId) ?? [])
          if (persisted !== undefined) parents.add(persisted)
          return [...parents]
        })
      )

    /**
     * Walks the parent DAG upward from `startId` looking for `targetId`. The
     * edges are the persisted `parentExecutionId` (the creating parent) plus
     * every recorded second-parent request edge — a diamond gives a run two
     * parents, and a cycle reachable only through the second one must still
     * be reported.
     *
     * A repeated id that is not `targetId` (a pre-existing corrupt cycle in
     * the store) terminates that branch rather than looping forever.
     */
    const detectCycle = (
      targetId: string,
      startId: string
    ): Effect.Effect<void, FlowCycleDetected> =>
      Effect.gen(function*() {
        if (startId === targetId) {
          return yield* Effect.fail(new FlowCycleDetected({ code: "flow_cycle_detected", path: [targetId] }))
        }

        const seen = new Set<string>([startId])
        const walk = (
          current: string,
          chain: ReadonlyArray<string>
        ): Effect.Effect<void, FlowCycleDetected> =>
          Effect.gen(function*() {
            const parents = yield* parentsOf(current)
            for (const parent of parents) {
              if (parent === targetId) {
                return yield* Effect.fail(
                  new FlowCycleDetected({
                    code: "flow_cycle_detected",
                    path: [...chain, parent].reverse()
                  })
                )
              }
              if (seen.has(parent)) continue
              seen.add(parent)
              yield* walk(parent, [...chain, parent])
            }
          })
        yield* walk(startId, [startId])
      })

    const poll: Service["poll"] = Effect.fn("FlowEngine.poll")((flow, executionId) =>
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
                state.flowName !== flow._tag ||
                state.result === undefined
              ) {
                return Effect.succeedNone
              }
              return (Schema.decodeUnknownEffect(
                Schema.toCodecJson(Flow.Result({
                  success: flow.successSchema,
                  error: flow.errorSchema
                }))
              )(state.result).pipe(
                Effect.orDie,
                Effect.map(Option.some)
              ) as Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>>)
            })
          )
        })
      )
    )

    /** Serializes cycle check + edge record across concurrent executes (issue #29). */
    const cycleGate = yield* Semaphore.make(1)

    const execute: Service["execute"] = Effect.fn("FlowEngine.execute")(
      function*<const Discard extends boolean>(
        flow: Flow.Any,
        options: {
          readonly executionId: string
          readonly payload: object
          readonly discard: Discard
          readonly parent?: FlowEngine.FlowInstance["Service"] | undefined
        }
      ) {
        if (!registrations.has(flow._tag)) {
          return yield* Effect.die(
            new Error(`Flow ${flow._tag} is not registered`)
          )
        }
        // The cycle check and the edge record must be one atomic step: two
        // concurrent executes that jointly close a cycle would otherwise
        // both observe a cycle-free graph before either records its edge,
        // then deadlock on mutual `coordinator.run` (issue #29). The gate
        // covers only check+record — never `coordinator.run` — so nested
        // child executes cannot deadlock on it.
        yield* Semaphore.withPermits(cycleGate, 1)(
          Effect.gen(function*() {
            if (options.parent !== undefined) {
              yield* detectCycle(options.executionId, options.parent.executionId)
            }
            yield* ensureRun(flow, options)
          })
        )
        yield* coordinator.run(options.executionId)
        if (options.discard) return undefined as Discard extends true ? void : never
        const result = yield* poll(flow, options.executionId)
        return Option.getOrElse(result, () => new Flow.Suspended({})) as Discard extends true ? void
          : Flow.Result<unknown, unknown>
      }
    )

    const interrupt = Effect.fn("FlowEngine.interrupt")((
      _flow: Flow.Any,
      executionId: string
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const instance = liveInstances.get(executionId)
        if (instance !== undefined) instance.interrupted = true
        // Operator intent is recorded durably before the fiber interrupt so
        // the interruption handler can tell cancellation apart from shutdown
        // (issue #26), and so the request survives if this process dies
        // before the interrupt lands.
        const nowMs = yield* Clock.currentTimeMillis
        yield* store.requestCancel(executionId, nowMs).pipe(Effect.ignore)
        yield* coordinator.interrupt(executionId)
      })
    )

    const scheduleResume: Service["scheduleResume"] = Effect.fn("FlowEngine.scheduleResume")((
      flowName,
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
        if (state.flowName !== flowName) return
        yield* emitDecision(executionId, {
          decision: "wake-scheduled",
          reason
        })
        yield* coordinator.wake(executionId)
      })
    )

    return {
      register: Effect.fn("FlowEngine.register")((flow, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const registration = { flow, execute: handler }
            registrations.set(flow._tag, registration)
            return registration
          }),
          (registration) =>
            Effect.sync(() => {
              if (registrations.get(flow._tag) === registration) {
                registrations.delete(flow._tag)
              }
            })
        ).pipe(Effect.asVoid)
      ),
      execute,
      poll,
      interrupt,
      interruptUnsafe: Effect.fn("FlowEngine.interruptUnsafe")(interrupt),
      resume: Effect.fn("FlowEngine.resume")((flow, executionId) =>
        scheduleResume(flow._tag, executionId, "operator").pipe(
          Effect.andThen(coordinator.run(executionId))
        )
      ),
      scheduleResume,
      active: Effect.fn("FlowEngine.active")(() => coordinator.active)()
    }
  })
