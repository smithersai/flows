/**
 * Claim-gated durable flow run lifecycle.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 */
import { FlowEngine } from "@smthrs/engine-next"
import { Flow, FlowRuntime } from "@smthrs/flow-next"
import { Journal } from "@smthrs/journal-next"
import { Ownership, RunStore } from "@smthrs/run-store-next"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import { RunState } from "../RunState.ts"
import * as ActivityPersistence from "./ActivityPersistence.ts"
import * as EffectRecords from "./EffectRecords.ts"
import * as JournalRecords from "./JournalRecords.ts"
import * as RunCoordinator from "./RunCoordinator.ts"

const RunStateJson = Schema.fromJsonString(RunState)

/**
 * Raised when a flow (directly or through mutual ancestry) attempts to
 * execute an execution id that already appears in its own persisted
 * `parentExecutionId` chain.
 *
 * Detection walks the already-persisted parent chain from the requesting
 * parent upward — an O(depth) check, not a dependency-graph DFS — because
 * `parentExecutionId` is the only edge our runtime model can express.
 *
 * The class is declared by `@smthrs/flow-next` (it is part of the `execute`
 * contract) and re-exported here for the detector's callers. See
 * `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 * @category errors
 */
export const FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * The value form of {@link FlowCycleDetected}.
 *
 * @since 0.1.0
 * @category errors
 */
export type FlowCycleDetected = FlowRuntime.FlowCycleDetected

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
  readonly engine: Effect.Effect<FlowRuntime.FlowRuntime["Service"]>
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
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
}

/**
 * The effect kind a detached child spawn is journaled under, and therefore the
 * kind an engine composition registers a spawn-compensation handler for.
 *
 * @since 0.1.0
 * @category constants
 */
export const spawnEffectKind = "flows/engine-store/child-spawn"

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

const withoutResult = (state: RunState): RunState => {
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
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
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
    const liveInstances = new Map<string, FlowRuntime.FlowInstance["Service"]>()
    const encodeState = (state: RunState): Effect.Effect<string> =>
      Schema.encodeEffect(RunStateJson)(state).pipe(Effect.orDie)

    const decodeState = (stateJson: string): Effect.Effect<RunState> =>
      Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(Effect.orDie)

    /**
     * Run decisions are lifecycle records: they take the journal's durable
     * channel so a saturated lossy queue can never drop them (issue #10).
     * They stay ownerless because several decisions — `claim-lost`,
     * `steal-refused-owner-alive`, post-transition `transitioned` — are
     * legitimately recorded by a process that does not (or no longer does)
     * own the run; the ownership fence for these paths is the run-row CAS
     * that precedes each emit.
     *
     * `meta.lineageId` is a JOURNAL lineage id (`FlowEngine.Lineage`,
     * `<runId>/root`), because that is the space a time-travel frame addresses:
     * `docs/specs/Concepts/Time Travel.md` makes a frame `(lineageId, seq)`, and
     * replay skips an entry whose `meta.lineageId` names a different lineage.
     * The run row's `lineageId` column is a different space — the TRAMPOLINE
     * lineage of `docs/specs/Concepts/Trampoline Loops.md`, round 0's execution
     * id.
     *
     * DECIDED (2026-08-12): decisions address the journal lineage of the run
     * that records them, one per round, the same lineage that run's attempt
     * and snapshot records already carry. Reading the run row's trampoline
     * lineage here put a run's decisions in a lineage its own attempts do not
     * address, so a rewind of that run skipped them. The trampoline lineage is
     * not lost: `created` and `handed-off` carry `lineageId` and
     * `roundOrdinal` in the decision payload, which is what walks a whole
     * trampoline chain.
     */
    const emitDecision = (
      runId: string,
      payload: unknown
    ): Effect.Effect<void> =>
      journal.emitDurable(
        JournalRecords.runDecision({
          runId,
          lineageId: FlowEngine.Lineage.root(runId),
          sourceId: dependencies.journalSource
        }, payload)
      ).pipe(Effect.asVoid, Effect.orDie)

    /**
     * Commits a run-row transition and the decision describing it in ONE write
     * transaction, reporting the store outcome.
     *
     * `RunStore` and the journal write through the same `DurableWriter`, so the CAS
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
      decision: unknown,
      guard?: RunStore.TransitionGuard | undefined
    ): Effect.Effect<RunStore.TransitionOutcome> =>
      journal.transact(
        Effect.gen(function*() {
          const transitioned = yield* store.transitionOwned(
            runId,
            dependencies.owner,
            toStatus,
            stateJson,
            guard
          ).pipe(Effect.orDie)
          if (transitioned._tag !== "Transitioned") return transitioned
          // The decision carries the state it committed, so run state at a
          // frame is DERIVED by replaying decisions rather than read off the
          // run row's current `state_json`
          // (`docs/specs/Concepts/Time Travel.md`; Temporal's
          // `ndc/state_rebuilder.go` is the model). Without it a fork at an
          // early frame silently inherited the parent's *latest* state.
          yield* emitDecision(runId, { ...(decision as object), state: JSON.parse(stateJson) })
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
      state: RunState
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
                lineageId: FlowEngine.Lineage.root(runId),
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
      state: RunState
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
          { decision: "interrupt-released", owner: dependencies.owner }
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
      state: RunState
    ): Effect.Effect<void> =>
      store.get(runId).pipe(
        Effect.map((row) => row.cancelRequestedAtMs !== null),
        Effect.catch(() => Effect.succeed(false)),
        Effect.flatMap((requested) => requested ? cancelOwned(runId, state) : releaseOwned(runId, state))
      )

    const encodeResult = (
      flow: Flow.Any,
      result: Flow.Result<unknown, unknown>
    ): Effect.Effect<unknown> =>
      Schema.encodeEffect(
        Schema.toCodecJson(Flow.Result({
          success: flow.successSchema,
          error: flow.errorSchema
        }))
      )(result).pipe(Effect.orDie) as Effect.Effect<unknown>

    /**
     * Re-encodes a handoff payload through the target flow's own codec, so the
     * bytes the next round's row holds are the bytes `ensureRun` would write
     * for the same invocation.
     */
    const normalizePayload = (
      flow: Flow.Any,
      payload: unknown
    ): Effect.Effect<unknown> => {
      const codec = Schema.toCodecJson(flow.payloadSchema)
      return (Schema.decodeUnknownEffect(codec)(payload).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => Schema.encodeEffect(codec)(decoded)),
        Effect.orDie
      ) as Effect.Effect<unknown>)
    }

    /**
     * Creates one run row, tolerating only an existing row with identical
     * execution identity and encoded invocation data.
     */
    const ensureCreatedRun = (options: {
      readonly flowName: string
      readonly executionId: string
      readonly stateJson: string
      readonly payload: unknown
      readonly lineageId: string
      readonly roundOrdinal: number
      readonly parentRunId?: string | undefined
      readonly onCreated: Effect.Effect<void, never, never>
    }): Effect.Effect<void, never, never> =>
      Effect.gen(function*() {
        const created = yield* store.create(options.executionId, options.stateJson, {
          ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
          lineageId: options.lineageId,
          roundOrdinal: options.roundOrdinal
        }).pipe(Effect.exit)
        if (Exit.isSuccess(created)) {
          return yield* options.onCreated
        }

        // A cause carrying no `Fail` reason — an interrupt-only cause, or a
        // bare defect — used to reach `Option.getOrThrow(Exit.findErrorOption(...))`,
        // which threw a raw `NoSuchElementError` defect and discarded the
        // original cause. A caller that interrupted the fiber while
        // `store.create` was inside its write transaction saw a crash rather
        // than the cancellation it asked for. `Cause.findFail` hands back
        // that residual cause typed `Cause<never>`, so re-raising it verbatim
        // keeps an interrupt an interrupt (issue #151).
        const failure = Cause.findFail(created.cause)
        if (Result.isFailure(failure)) {
          return yield* Effect.failCause(failure.failure)
        }
        const error = failure.success.error
        if (!(error instanceof RunStore.RunStoreError) || error.code !== "constraint") {
          return yield* Effect.die(error)
        }
        const existing = yield* store.get(options.executionId).pipe(Effect.orDie)
        const persisted = yield* decodeState(existing.stateJson)
        // A pre-lineage round-0 row has null metadata. It remains an identical
        // root create after the additive migration; later rounds must carry
        // the exact chain metadata because no earlier build could create them.
        const legacyRoot = options.roundOrdinal === 0 &&
          existing.lineageId == null &&
          existing.roundOrdinal == null
        const sameRound = legacyRoot ||
          (existing.lineageId === options.lineageId && existing.roundOrdinal === options.roundOrdinal)
        const sameParent = options.parentRunId === undefined ||
          existing.parentRunId === options.parentRunId
        if (
          persisted.flowName !== options.flowName ||
          !samePayload(persisted.payload, options.payload) ||
          !sameRound ||
          !sameParent
        ) {
          return yield* Effect.die(
            new Error(
              `execution ${options.executionId} already belongs to a different flow tag or encoded payload, lineage, or round`
            )
          )
        }
      })

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

    /**
     * What one handoff has to settle: the round that produced it, the row it
     * runs under (which carries the lineage columns), the state it was
     * activated with, its declaration, and the invocation it named.
     */
    interface HandoffSeam {
      readonly executionId: string
      readonly row: RunStore.RunRow
      readonly state: RunState
      readonly flow: Flow.Any
      readonly handoff: Flow.Handoff
    }

    /**
     * Opens the next round, and closes this one, in ONE transaction.
     *
     * `ensureRun`'s parent-edge/run-row pairing (issue #80) is the precedent
     * and the reason: a crash between the two writes would leave a terminal
     * round whose successor was never created, and nothing would ever look for
     * it again — the lineage would end silently at a round that says it handed
     * off. The stores' own writes become savepoints of this transaction, so
     * either both commit or neither.
     *
     * The next round is a run row chained through the RESERVED
     * `parent_run_id` column, not a `flows_run_parents` edge: that table is
     * the subflow DAG cycle detection walks, and a round is the same run
     * continuing rather than a child being spawned
     * (`docs/specs/Concepts/Trampoline Loops.md`).
     */
    const continueLineage = (
      seam: HandoffSeam,
      advanced: { readonly round: FlowEngine.Round.Round; readonly executionId: string }
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // The handoff payload travels encoded, and the next round's row has to
        // hold the same bytes `ensureRun` would write for it: the root caller
        // re-enters `execute` for this round, and its identical-create check
        // compares the ENCODED payload. Round-tripping through the target's own
        // codec is what makes the two agree regardless of the key order the
        // body's object literal happened to have.
        //
        // A target this process does not run has no codec to normalize
        // through, and the round is still created with the payload verbatim —
        // the same posture the wake path takes for an unregistered flow, and
        // the reason a lineage survives a worker that only knows some of its
        // legs.
        const target = registrations.get(seam.handoff.flow)
        const payload = target === undefined
          ? seam.handoff.payload
          : yield* normalizePayload(target.flow, seam.handoff.payload)
        const nextStateJson = yield* encodeState({
          version: 1,
          flowName: seam.handoff.flow,
          payload,
          ...(seam.state.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: seam.state.parentExecutionId }),
          ...(seam.state.maxRounds === undefined ? {} : { maxRounds: seam.state.maxRounds })
        })
        const settledStateJson = yield* encodeState({
          ...seam.state,
          result: yield* encodeResult(seam.flow, seam.handoff)
        })
        const cancelled = { _tag: "HandoffCancelled" } as const
        const fenceLost = { _tag: "HandoffFenceLost" } as const
        const committed = yield* Effect.result(
          engineState.transaction(Effect.gen(function*() {
            // The next round's id is DERIVED from (lineage, ordinal), so a
            // re-drive finds the exact row it already opened. Only an
            // identical create is tolerated; a collision in flow, payload,
            // parent, lineage, or ordinal is a defect.
            yield* ensureCreatedRun({
              flowName: seam.handoff.flow,
              executionId: advanced.executionId,
              stateJson: nextStateJson,
              payload,
              lineageId: advanced.round.lineageId,
              roundOrdinal: advanced.round.ordinal,
              parentRunId: seam.executionId,
              onCreated: emitDecision(advanced.executionId, {
                decision: "created",
                state: JSON.parse(nextStateJson),
                lineageId: advanced.round.lineageId,
                roundOrdinal: advanced.round.ordinal,
                parentExecutionId: seam.executionId
              })
            })
            // DECIDED (2026-08-11, pending review): a handed-off round settles
            // `completed`. The round did finish, and adding a `Continued`
            // status would widen every status reader for a distinction the
            // `handed-off` decision and lineage columns already record.
            //
            // DECIDED (2026-08-11, pending review): cancellation guards the
            // handoff transition. If it raced the last poll, failing the outer
            // transaction rolls successor creation back before the ordinary
            // cancellation path closes the owned round.
            const transitioned = yield* transitionAndRecord(
              seam.executionId,
              "completed",
              settledStateJson,
              {
                decision: "handed-off",
                status: "completed",
                flow: seam.handoff.flow,
                lineageId: advanced.round.lineageId,
                roundOrdinal: advanced.round.ordinal,
                nextExecutionId: advanced.executionId,
                owner: dependencies.owner
              },
              { cancelRequested: "absent" }
            )
            if (transitioned._tag === "Transitioned") return
            return yield* Effect.fail(
              transitioned._tag === "GuardFailed" ? cancelled : fenceLost
            )
          }))
        )
        if (Result.isFailure(committed)) {
          if (committed.failure._tag === "HandoffCancelled") {
            yield* cancelOwned(seam.executionId, seam.state)
          }
          return
        }
        // The root caller follows the lineage itself, but a discarded (or
        // orphaned) one does not exist to follow it, so the successor is woken
        // here rather than left for a sweep that has no reason to look at it.
        const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
        yield* activeCoordinator.wake(advanced.executionId)
      })

    /**
     * Ends a lineage that asked for one round past its declared budget.
     *
     * The round itself ran to completion; what is refused is the handoff, so
     * the round settles `failed` carrying the typed refusal and no successor
     * is created (`docs/specs/Concepts/Trampoline Loops.md` §Budget).
     */
    const endLineage = (
      seam: HandoffSeam,
      error: Flow.MaxRoundsExceeded
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stateJson = yield* encodeState({
          ...seam.state,
          result: yield* encodeResult(seam.flow, new Flow.Complete({ exit: Exit.die(error) }))
        })
        const transitioned = yield* transitionAndRecord(
          seam.executionId,
          "failed",
          stateJson,
          {
            decision: "lineage-exhausted",
            status: "failed",
            lineageId: error.lineageId,
            maxRounds: error.maxRounds,
            owner: dependencies.owner
          },
          { cancelRequested: "absent" }
        )
        if (transitioned._tag === "GuardFailed") {
          yield* cancelOwned(seam.executionId, seam.state)
        }
      })

    /**
     * The handoff seam: the one place a round's terminal settlement and its
     * successor are decided together.
     */
    const handOff = (seam: HandoffSeam): Effect.Effect<void, never, Crypto.Crypto> =>
      FlowEngine.Round.next(
        {
          lineageId: seam.row.lineageId ?? seam.executionId,
          ordinal: seam.row.roundOrdinal ?? 0
        },
        // The origin persisted its budget into every round's state, so a
        // multi-flow handoff cannot reset the lineage by changing targets.
        { flowName: seam.flow._tag, maxRounds: seam.state.maxRounds }
      ).pipe(
        Effect.flatMap((advanced) => continueLineage(seam, advanced)),
        Effect.catch((error) => endLineage(seam, error))
      )

    const drive = (executionId: string): Effect.Effect<void, never, Crypto.Crypto> =>
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
        const instance = FlowEngine.makeInstance(
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
                Effect.provideService(FlowRuntime.FlowInstance, instance),
                Effect.provideService(FlowRuntime.FlowRuntime, flowEngine)
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

        // Corrupt evidence on a SUCCEEDED attempt row is an operator-visible
        // event, not a terminal run failure (issue #171): the row cannot be
        // evicted and re-executed like a corrupt cache row (#164) without
        // breaking exactly-once. ActivityPersistence has already journalled
        // the corruption and quarantined only its boundary evidence off the
        // row. Park this first strict detection so it remains visible; the
        // next explicit resume returns the durable outcome without replaying
        // the poison or re-executing the activity.
        const quarantine = result._tag === "Complete" && Exit.isFailure(result.exit)
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
              decision: "quarantined",
              status: "suspended",
              keyDigest: quarantine.keyDigest,
              owner: dependencies.owner
            },
            { cancelRequested: "absent" }
          )
          if (parked._tag === "GuardFailed") {
            return yield* cancelOwned(executionId, activeState)
          }
          return
        }

        // A round that handed off settles through the seam instead: its
        // terminal transition and its successor's creation are one write, so
        // it cannot share the ordinary terminal path below.
        if (result._tag === "Handoff") {
          return yield* handOff({
            executionId,
            row: initial,
            state: activeState,
            flow: registration.flow,
            handoff: result
          })
        }

        const encodedResult = yield* encodeResult(registration.flow, result)
        const nextState: RunState = { ...activeState, result: encodedResult }
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
          // A flow-declared classification (FlowRuntime.annotateWaiting) wins:
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
          { decision: "transitioned", status, owner: dependencies.owner },
          { cancelRequested: "absent" }
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

    const coordinator = yield* RunCoordinator.make<string, never, Crypto.Crypto>({
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
        readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
        readonly round?:
          | (FlowEngine.Round.Round & {
            readonly previousExecutionId?: string | undefined
          })
          | undefined
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
          const round = options.round ?? FlowEngine.Round.initial(options.executionId)
          const previousExecutionId = options.round?.previousExecutionId
          const state: RunState = {
            version: 1,
            flowName: flow._tag,
            payload,
            ...(options.parent === undefined
              ? {}
              : { parentExecutionId: options.parent.executionId }),
            ...(flow.maxRounds === undefined ? {} : { maxRounds: flow.maxRounds })
          }
          const createdStateJson = yield* encodeState(state)
          yield* ensureCreatedRun({
            flowName: flow._tag,
            executionId: options.executionId,
            stateJson: createdStateJson,
            payload,
            lineageId: round.lineageId,
            roundOrdinal: round.ordinal,
            ...(previousExecutionId === undefined
              ? {}
              : { parentRunId: previousExecutionId }),
            onCreated: Effect.gen(function*() {
              // The run's opening frame. `store.create` used to be the one
              // durable write with no journal record at all, which left the
              // replay-derived state projection with no base to fold onto —
              // `flowName` and `payload` exist nowhere else in the journal.
              // The state travels ENCODED, exactly as every later decision
              // carries it: `stateAt` folds these payloads and hands the winner
              // back as the run row's own `state_json`, so a base recorded in the
              // decoded shape would be a schema the caller cannot decode.
              yield* emitDecision(options.executionId, {
                decision: "created",
                state: JSON.parse(createdStateJson),
                ...(options.parent === undefined ? {} : { parentExecutionId: options.parent.executionId })
              })
              if (options.parent !== undefined) {
                // A spawn is a lineage edge, and a DETACHED spawn is a tier-3
                // effect: nothing the parent's rewind can undo, because the child
                // is its own claim and its own journal
                // (`docs/specs/Concepts/Subflows.md` §detached spawn). The record
                // is boundary-shaped so the same assessment that classifies a
                // sent webhook classifies an orphaned child, and it is emitted at
                // `succeeded` because by this point the child run durably exists.
                yield* journal.emitDurable(
                  EffectRecords.boundary(
                    {
                      id: `${options.parent.executionId}:spawn:${options.executionId}`,
                      kind: spawnEffectKind,
                      tier: "irreversible",
                      runId: options.parent.executionId,
                      lineageId: FlowEngine.Lineage.root(options.parent.executionId),
                      sourceId: dependencies.journalSource,
                      attempt: 1,
                      residue:
                        `Child run ${options.executionId} exists and keeps its own journal; rewinding past its spawn orphans it.`
                    },
                    "succeeded",
                    // `attached` is written even though it is always false: the
                    // lineage-tree bridge in `@smthrs/time-travel-next` reads it off
                    // this payload, and an absent field there would make "this
                    // spawn is detached" indistinguishable from "this producer
                    // predates the field". A run created with a parent is a
                    // separate run row with its own claim, which is what detached
                    // means (`docs/specs/Concepts/Subflows.md`); attached nesting
                    // never reaches `create` because it is one journal.
                    { childRunId: options.executionId, flowName: flow._tag, attached: false }
                  )
                ).pipe(Effect.orDie)
              }
            })
          })
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
          readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
          readonly round?:
            | (FlowEngine.Round.Round & {
              readonly previousExecutionId?: string | undefined
            })
            | undefined
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
