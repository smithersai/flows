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
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as ActivityPersistence from "./ActivityPersistence.ts"
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

/**
 * How many stale-running rows one heartbeat tick may wake (issue #79).
 * Oldest heartbeats surface first, so a backlog larger than the batch
 * drains across ticks; each successful steal removes the row from the
 * stale window, and losing drivers see a shrinking batch next tick.
 */
const staleRunningSweepBatch = 64
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
    /**
     * Runs already warned about waking without a registered flow (issue
     * #62): the sweep retries every heartbeat, so the warning is emitted
     * once per run, not once per tick. Cleared on every registration — a
     * newly registered flow makes previously dropped runs drivable again.
     */
    const warnedUnregistered = new Set<string>()
    const liveInstances = new Map<string, FlowEngine.FlowInstance["Service"]>()
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

    /**
     * Commits a run-row transition and the decision describing it in ONE write
     * transaction, reporting the store outcome.
     *
     * `RunStore` and the journal write through the same `Database`, so the CAS
     * becomes a savepoint of this transaction: a crash can no longer leave a
     * terminal run row whose `transitioned` decision never reached the
     * journal, nor a decision for a CAS that lost. Temporal commits mutable
     * state and its history events as one persistence request
     * (`reference/temporal/service/history/workflow/transaction_impl.go`);
     * this is the same unit of work for a run transition.
     *
     * The decision is emitted only for a `Transitioned` outcome — a lost CAS
     * changed nothing, and its `claim-lost`/`activation-lost` records are
     * emitted by the caller, outside the transaction, so they survive.
     */
    const transitionAndRecord = (
      runId: string,
      toStatus: RunStore.RunStatus,
      stateJson: string,
      options: {
        readonly guard?: RunStore.TransitionGuard | undefined
        readonly decision?: unknown
        readonly onTransitioned?: Effect.Effect<void> | undefined
      } = {}
    ): Effect.Effect<RunStore.TransitionOutcome> =>
      journal.transact(
        Effect.gen(function*() {
          const transitioned = yield* store.transitionOwned(
            runId,
            dependencies.owner,
            toStatus,
            stateJson,
            options.guard
          ).pipe(Effect.orDie)
          if (transitioned._tag !== "Transitioned") return transitioned
          if (options.onTransitioned !== undefined) yield* options.onTransitioned
          if (options.decision !== undefined) yield* emitDecision(runId, options.decision)
          return transitioned
        })
      ).pipe(Effect.orDie)

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

        // The activation CAS and the decision recording it commit together:
        // a crash between them left a run durably running under this owner
        // with no journal entry saying who took it.
        const activation = yield* journal.transact(
          Effect.gen(function*() {
            const activation = yield* store.activate(
              row.runId,
              dependencies.owner,
              claim.claimedAtMs,
              expected
            ).pipe(Effect.orDie)
            if (activation._tag !== "Activated") return activation
            yield* emitDecision(row.runId, {
              decision: row.status === "running" ? "stolen-and-activated" : "claimed-and-activated",
              previousStatus: row.status,
              owner: dependencies.owner
            })
            return activation
          })
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
        yield* journal.transact(
          Effect.gen(function*() {
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
            // (issue #28). It shares the transition's transaction, so a crash
            // can no longer land between them.
            yield* engineState.wake(runId).pipe(Effect.asVoid)
            // Durable channel (issue #10): the interruption record must survive
            // the process exiting right after cancellation. Ownerless because the
            // `cancelled` transition above has already released ownership; the
            // fence is the transition CAS itself, which now commits with this
            // record rather than before it.
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
        // Park before releasing ownership (`park` is owner-fenced). The
        // durable waiting row is what makes a released run visible to the
        // parked-run sweeper: without it nothing ever re-drives the run and
        // a durable `requestCancel` against it is write-only forever
        // (issue #39). On genuine fence loss the park reports NotFound
        // harmlessly, exactly like the transition below.
        const parked = yield* engineState.park(runId, { reason: "released" }, dependencies.owner)
        const transitioned = yield* transitionAndRecord(
          runId,
          "suspended",
          yield* encodeState(withoutResult(state)),
          { decision: { decision: "interrupt-released", owner: dependencies.owner } }
        )
        if (transitioned._tag !== "Transitioned") {
          // Fence lost between park and release: the run is someone else's
          // (or already settled), so our reclaim marker is bogus. Clear it
          // only if it is still ours — a new owner may have parked a real
          // waiting reason in between.
          if (parked._tag === "Parked") {
            const current = yield* engineState.waiting(runId)
            if (Option.isSome(current) && current.value.reason === "released") {
              yield* engineState.wake(runId)
            }
          }
          return
        }
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
        Effect.flatMap((requested) => requested ? cancelOwned(runId, state) : releaseOwned(runId, state))
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
        if (registration === undefined) {
          // A wake for a flow this process has not registered — after a full
          // restart the sweep re-drives released rows before (or without)
          // the flow ever registering here. Dropping the wake silently made
          // the #39 reclaim guarantee invisibly conditional on registration
          // (issue #62): warn (once per run, the sweep retries every
          // heartbeat) and leave the durable waiting row untouched so any
          // process that does register the flow still reclaims the run.
          if (!warnedUnregistered.has(executionId)) {
            warnedUnregistered.add(executionId)
            yield* Effect.logWarning(
              `engine-store: run ${executionId} woke for flow ${state.flowName}, which is not registered in this process; leaving it parked for a worker that registers the flow`,
              { runId: executionId, flowName: state.flowName }
            )
          }
          return
        }
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

        // Corrupt evidence on a SUCCEEDED attempt row is an operator event,
        // not a run failure (issue #171): the row cannot be evicted and
        // re-executed like a corrupt cache row (#164) without breaking
        // exactly-once, and settling the run `failed` made the corruption a
        // permanent opaque terminal — every resume re-read the same row and
        // re-failed forever. Park the run `quarantine` instead: the
        // corruption is already journalled by the Inconsistency receiver, no
        // sweeper wakes this reason, and an operator resumes the run after
        // restoring the evidence (or time-travelling past the attempt) by
        // re-driving it. A premature wake re-detects and re-parks — safe.
        const quarantine = result._tag !== "Suspended" && Exit.isFailure(result.exit)
          ? ActivityPersistence.evidenceQuarantined(result.exit.cause)
          : undefined
        if (quarantine !== undefined) {
          yield* engineState.park(
            executionId,
            { reason: "quarantine", token: quarantine.keyDigest },
            dependencies.owner
          )
          const parked = yield* transitionAndRecord(
            executionId,
            "suspended",
            yield* encodeState(withoutResult(activeState)),
            {
              guard: { cancelRequested: "absent" },
              decision: {
                decision: "quarantined",
                status: "suspended",
                keyDigest: quarantine.keyDigest,
                owner: dependencies.owner
              }
            }
          )
          if (parked._tag === "GuardFailed") {
            return yield* cancelOwned(executionId, activeState)
          }
          return
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
        const transitioned = yield* transitionAndRecord(
          executionId,
          status,
          yield* encodeState(nextState),
          {
            guard: { cancelRequested: "absent" },
            decision: { decision: "transitioned", status, owner: dependencies.owner }
          }
        )
        if (transitioned._tag === "GuardFailed") {
          return yield* cancelOwned(executionId, activeState)
        }
        if (transitioned._tag !== "Transitioned") return
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
     *
     * The same sweep reclaims interrupt-released runs (issue #39): a run
     * parked with reason `released` was interrupted mid-activity by shutdown
     * or a heartbeat self-interrupt, has no pending clock and no completed
     * deferred, and would otherwise never be re-driven. Waking it re-enters
     * the ordinary claim/activate path, which also delivers any pending
     * cancel via the activation guard.
     */
    const sweepCancelRequested: Effect.Effect<void> = Effect.gen(function*() {
      // Fetch only actionable rows (issue #68): the sweep acts solely on
      // released rows and rows whose cancellation was durably requested, so
      // a large quota/event-parked fleet must cost it nothing per tick. The
      // per-row `store.get` below is a status guard over the (small)
      // actionable set, not a probe over every parked run — the in-memory
      // implementation without a `runs` view stays permissive on the cancel
      // predicate and relies on exactly this guard.
      const released = yield* engineState.waitingRuns({ reason: "released" })
      const cancelRequestedRows = yield* engineState.waitingRuns({ cancelRequested: true })
      const candidates = new Map<string, DurableEngineState.WaitingRow>()
      for (const waiting of released) candidates.set(waiting.runId, waiting)
      for (const waiting of cancelRequestedRows) candidates.set(waiting.runId, waiting)
      for (const waiting of candidates.values()) {
        const row = yield* store.get(waiting.runId).pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        if (
          row !== undefined &&
          row.status === "suspended" &&
          (row.cancelRequestedAtMs !== null || waiting.reason === "released")
        ) {
          yield* coordinator.wake(row.runId)
        }
      }
    })
    /**
     * Reclaims hard-killed runs (issue #53). An owner that dies without
     * releasing (SIGKILL, OOM, power loss) leaves a `running` row with a
     * frozen heartbeat and no waiting row, so the parked-run sweep above
     * never sees it, and the steal path — reachable only through `drive()` —
     * is never entered. Enumerate stale-running rows and re-drive them: the
     * ordinary claim/steal path (liveness check, exact-snapshot steal CAS)
     * then decides whether the owner is genuinely dead — the analog of
     * Temporal's task-timeout re-dispatch. A pending durable cancel is
     * delivered by the re-activation guard, same as for parked runs.
     */
    const sweepStaleRunning: Effect.Effect<void> = Effect.gen(function*() {
      const nowMs = yield* Clock.currentTimeMillis
      // Capped per tick (issue #79): oldest heartbeats come back first, so a
      // mass owner death drains across successive ticks — batch after batch
      // as each stolen run's heartbeat leaves the stale window — instead of
      // every surviving driver waking every stale run every second and
      // contending N-drivers × M-runs on the claim/steal CAS.
      const stale = yield* engineState.staleRunningRuns(
        nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter),
        staleRunningSweepBatch
      )
      for (const runId of stale) {
        yield* coordinator.wake(runId)
      }
    })
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(Ownership.heartbeatInterval).pipe(
          Effect.andThen(
            // One transient defect (a `SQLITE_BUSY` escaping `waitingRuns()`'s
            // `orDie`, a wake failure) must not kill the sweeper for the rest
            // of the process lifetime (issue #44) — that would silently revert
            // to pre-#27 behavior where cancel of parked runs is never
            // delivered. Mirror `armClock`'s hardening: expose the full cause,
            // log it, and keep ticking.
            sweepCancelRequested.pipe(
              Effect.andThen(sweepStaleRunning),
              Effect.sandbox,
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "engine-store: parked-run cancel sweep failed; retrying next tick",
                  cause
                )
              )
            )
          )
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
    ): Effect.Effect<void, FlowCycleDetected> =>
      Effect.gen(function*() {
        const payload = yield* (Schema.encodeEffect(
          Schema.toCodecJson(flow.payloadSchema)
        )(
          options.payload
        ).pipe(Effect.orDie) as Effect.Effect<unknown>)
        // Every requested parent — first (creating) parent and a diamond's
        // second parent alike — is recorded as a durable edge BEFORE the run
        // row is created. `recordRunParent` inserts the edge and checks for
        // a cycle inside one storage transaction (issues #29/#40/#54/#56),
        // so a rejected request fails here and never creates a run row — no
        // `state_json` parent can outlive a rejected edge (issue #55). The
        // edge table is the single source of truth for cycle detection in
        // every owner process and across restarts (issues #40/#41).
        //
        // The edge record and the run-row creation share one outer storage
        // transaction (issue #80): a crash between them used to commit a
        // durable orphan edge for a child run that never existed — never
        // GC'd, permanently walked by cycle detection, and able to force a
        // false FlowCycleDetected if the execution id was later reused
        // under an inverted topology. The stores' own writes become
        // savepoints of this transaction, so either both commit or neither.
        yield* engineState.transaction(Effect.gen(function*() {
          if (options.parent !== undefined) {
            yield* engineState.recordRunParent(
              options.executionId,
              options.parent.executionId
            ).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new FlowCycleDetected({ code: "flow_cycle_detected", path: error.path })
                )
              )
            )
          }
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
          // The row already exists; the durable edge recorded above is the
          // only place a diamond's second parent lives (issues #41/#48): a
          // driver-local side table would be invisible to other owners over
          // the same store, lost across restart, and would grow without
          // bound for the driver's lifetime.
        }))
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
        // Cycle rejection happens atomically inside `ensureRun`'s call to
        // `DurableEngineState.recordRunParent`: the storage transaction that
        // inserts the edge also walks the parent chain and rolls back on a
        // hit, so no in-process gate, cross-owner arbitration, or withdrawal
        // protocol is needed here (issues #29/#40/#54/#55/#56) and the
        // mutual `coordinator.run` deadlock cannot form.
        yield* ensureRun(flow, options)
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
            warnedUnregistered.clear()
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
