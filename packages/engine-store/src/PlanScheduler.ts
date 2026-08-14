/**
 * Drives a persisted plan: the node scheduler.
 *
 * `@smthrs/plan-next` makes the plan a value; this makes it run. The scheduler
 * walks the persisted graph, dispatches ready nodes through the same
 * `internal/ActionPersistence` seam every action uses — so the shared step
 * cache, the workspace sandbox's execute→materialize transaction, attempt
 * rows, and the fenced journal all apply unchanged — and records one of four
 * evaluation outcomes per node.
 *
 * ## What it is, and what it is not
 *
 * Skyframe's `AbstractParallelEvaluator` is the prior art for the state
 * machine (`CHECK_DEPENDENCIES → VERIFIED_CLEAN | NEEDS_REBUILDING →
 * REBUILDING → DONE`) and `EvaluationProgressReceiver` for the outcome
 * vocabulary. Two deliberate deviations:
 *
 * 1. **No reverse-dependency index, no invalidating node visitor.**
 *    `docs/specs/Concepts/Engine Hardening Round 1.md` rejects both outright:
 *    content addressing subsumes them. A node is "dirty" iff the key it would
 *    dispatch under differs from the one it dispatched under, and the
 *    dispatch-time recheck already computes that. There is no dirty bit to
 *    propagate, so there is nothing for a visitor to walk.
 * 2. **A wavefront, not restart-based dependency discovery.** Skyframe
 *    restarts a `SkyFunction` when it asks for a value that is not ready; our
 *    dependencies are declared in the plan before anything runs, so a round
 *    admits every ready node the caps allow and waits for it. The cost is that
 *    a round is a barrier; the benefit is that scheduling is a pure function
 *    of the plan and the settled set, which is what makes these tests
 *    deterministic without the `DeterministicHelper` the vault rejected.
 *
 * ## The three limits
 *
 * `docs/specs/Concepts/Concurrency.md` insists the same number must never
 * stand in for graph width, scheduler admission, and provider capacity. This
 * module owns the middle one only: `concurrency.steps` is the leaf-execution
 * cap, and `concurrency.agents` is the subset cap an agent node consumes in
 * addition. Structural width is whatever the plan says; seats belong to
 * `Agent Adapters` and are not modelled here.
 *
 * Under contention, ready work is ordered by effective priority — declared
 * `priority` plus one point per round spent waiting. Aging is what lets
 * priority change latency without permitting starvation; equal effective
 * priorities preserve deterministic plan order.
 *
 * ## Observing the world exactly once
 *
 * `docs/specs/Concepts/Staleness.md`'s torn-run rule: never re-observe the
 * world mid-run. Paths the plan reads but no node writes are **source** paths;
 * they are measured once, before the first dispatch, and pinned for the rest
 * of the run. Paths a node in the plan produces are measured after their
 * producer settles — observing our own output, not the world.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto-next"
import { FlowEngine } from "@smthrs/engine-next"
import type { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import { Journal, type JournalEvent } from "@smthrs/journal-next"
import type { Jj } from "@smthrs/kernel-next"
import { Plan, PlanStore, StepKey } from "@smthrs/plan-next"
import type { AttemptStore, Ownership, RunStore } from "@smthrs/run-store-next"
import type { CacheStore } from "@smthrs/step-cache-next"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as ActionPersistence from "./internal/ActionPersistence.ts"
import * as JournalRecords from "./internal/JournalRecords.ts"
import * as Reconciliation from "./Reconciliation.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * The four evaluation outcomes: Skyframe's `EvaluationState` adapted to a
 * content-addressed store.
 *
 * - `built` — the node executed (`SUCCESS_VERSION_CHANGED`).
 * - `clean` — the shared cache served it and nothing ran
 *   (`SUCCESS_VERSION_UNCHANGED`). This is the outcome the whole design is
 *   for: an unchanged branch costs nothing.
 * - `failed` — the node executed and failed, or reconciliation failed it.
 * - `skipped` — the node never dispatched, because its cone failed or because
 *   a `stop-merge` strategy stopped it in favour of a merge node. Skyframe
 *   splits failure by version instead; a content-addressed store never serves
 *   a failure from cache, so that split has no meaning here and this one does.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome = "built" | "clean" | "failed" | "skipped"

/**
 * What the scheduler hands a node's executor.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeInput {
  readonly node: Plan.PlanNode
  readonly attempt: number
  /** The measured boundary this dispatch was keyed under. */
  readonly boundary: FileBoundary
  /** Results of the node's dependencies, by node id. */
  readonly inputs: Readonly<Record<string, unknown>>
}

/**
 * The DI seam that turns a plan node into work.
 *
 * The scheduler owns identity, admission, caching, and journaling; it
 * deliberately owns nothing about what a node *means*. A flow runtime, a test,
 * or a remote host each supply their own executor.
 *
 * @since 0.1.0
 * @category models
 */
export interface Executor {
  readonly execute: (input: NodeInput) => Effect.Effect<unknown, unknown>
}

/**
 * Service tag for the node executor.
 *
 * @since 0.1.0
 * @category services
 */
export class NodeExecutor extends Context.Service<NodeExecutor, Executor>()("flows/engine-store/NodeExecutor") {}

/**
 * Provides a plain {@link Executor} value as the {@link NodeExecutor} service.
 *
 * This is the whole wiring story for the scheduler's one open seam: a flow
 * runtime, a test double, or a remote dispatcher each become a layer by
 * passing themselves here.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerExecutor = (executor: Executor): Layer.Layer<NodeExecutor> => Layer.succeed(NodeExecutor, executor)

/**
 * How one node ended.
 *
 * @since 0.1.0
 * @category models
 */
export interface Settlement {
  readonly nodeId: string
  /** The plan-time key: a pure function of declarations. */
  readonly planKey: string
  /** The key dispatched under: the plan key folded with the measured boundary. */
  readonly dispatchKey: string
  readonly outcome: Outcome
  readonly attempts: number
  readonly rebases: number
}

/**
 * What a run of a plan produced.
 *
 * @since 0.1.0
 * @category models
 */
export interface Report {
  readonly planId: string
  readonly digest: string
  readonly settlements: ReadonlyArray<Settlement>
  readonly results: Readonly<Record<string, unknown>>
  readonly verdicts: ReadonlyArray<{ readonly nodeId: string; readonly verdict: Reconciliation.Verdict }>
  /** Merge nodes a `stop-merge` conflict appended to the plan. */
  readonly appended: ReadonlyArray<string>
}

/**
 * Scheduler construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly sourceId: string
  /**
   * The admission caps. Both default to unbounded, because a cap the caller
   * did not declare is not the scheduler's to invent — `aspects.ts` owns the
   * policy and narrows it. Both floor at one: a cap of zero admits nothing,
   * and a round that admits nothing never settles anything.
   */
  readonly concurrency?: {
    readonly steps?: number | undefined
    readonly agents?: number | undefined
  } | undefined
  /**
   * How many times a `delay-rebase` node may re-measure and re-key against a
   * newly recorded base before reconciliation is asked. Bounded on purpose: an
   * unbounded rebase loop is a livelock with good manners.
   */
  readonly rebaseLimit?: number | undefined
}

/**
 * Everything driving a plan needs from the composition.
 *
 * @since 0.1.0
 * @category models
 */
export type Requirements =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Crypto.Crypto
  | Jj.Jj
  | Journal.Journal
  | NodeExecutor
  | PlanStore.PlanStore
  | RunStore.RunStore
  | StepBoundary.Service

/**
 * A refusal the scheduler itself raises. A node's own failure is an outcome,
 * not one of these — the run continues and the report says `failed`.
 *
 * @since 0.1.0
 * @category errors
 */
export class SchedulerError extends Schema.TaggedError<SchedulerError>()("flows/engine-store/SchedulerError", {
  code: Schema.Literals(["boundary_unavailable", "key_uncomputable", "elaboration_failed", "store_failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Plan-driving operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  /** Persists generation 0 and journals `plan-recorded`. */
  readonly record: (
    plan: Plan.Plan
  ) => Effect.Effect<PlanStore.RecordResult, SchedulerError, PlanStore.PlanStore | Journal.Journal>
  /** Persists the newest generation and journals `subgraph-appended`. */
  readonly append: (plan: Plan.Plan) => Effect.Effect<void, SchedulerError, PlanStore.PlanStore | Journal.Journal>
  /** Drives the plan to completion and reports every node's outcome. */
  readonly run: (plan: Plan.Plan) => Effect.Effect<Report, SchedulerError, Requirements>
}

/**
 * Service tag for the plan scheduler.
 *
 * @since 0.1.0
 * @category services
 */
export class PlanScheduler extends Context.Service<PlanScheduler, Service>()("flows/engine-store/PlanScheduler") {}

/**
 * The declared digest handed to `StepBoundary.prepare` when the scheduler is
 * *asking* what a path holds rather than asserting it. Prepare measures every
 * declared read regardless of what the declaration claims, so any placeholder
 * works; a self-describing one can never be mistaken for a real digest.
 *
 * @private
 */
const unmeasured = "unmeasured"

/** @private */
const isConflict = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) =>
    Cause.isFailReason(reason) && reason.error instanceof WorkspaceSandbox.MaterializationConflict
  )

/** @private */
const DeviationPayload = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int,
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.String
})

const decodeDeviation = Schema.decodeUnknownOption(DeviationPayload)

const digestOf = Schema.decodeUnknownEffect(Sha256)

/** @private */
interface NodeState {
  status: "pending" | "settled"
  outcome: Outcome
  attempts: number
  rebases: number
  waited: number
  dispatchKey: string
}

/** @private */
type Dispatched =
  | { readonly outcome: "built" | "clean" | "failed" }
  | { readonly outcome: "conflicted"; readonly strategy: Plan.RuntimeStrategy }

const storeFailure = (message: string) => (cause: unknown) =>
  new SchedulerError({ code: "store_failed", message, cause })

/**
 * Constructs a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options): Service => {
  const rebaseLimit = options.rebaseLimit ?? 3
  // A cap below one is not admission control, it is a stop: a round that
  // admits nothing settles nothing, so the wavefront would spin forever
  // ageing work it can never dispatch. Both caps therefore floor at one — the
  // scheduler narrows latency, never liveness.
  const stepCap = Math.max(1, options.concurrency?.steps ?? Number.MAX_SAFE_INTEGER)
  const agentCap = Math.max(1, options.concurrency?.agents ?? Number.MAX_SAFE_INTEGER)

  // Every scheduler record addresses the run's root lineage, so a frame can
  // reach it (`docs/specs/Concepts/Time Travel.md`).
  const lineageId = FlowEngine.Lineage.root(options.runId)
  const source = (suffix: string) => ({ runId: options.runId, sourceId: `${options.sourceId}/${suffix}`, lineageId })

  /**
   * Scheduler records take the journal's durable, owner-fenced channel: a plan
   * digest binds an approval, so it may never ride the lossy queue. A zombie
   * that lost the run self-interrupts on `fence_lost`, exactly as
   * `internal/ActionPersistence` does — a scheduler that kept dispatching
   * after losing ownership is the failure mode fencing exists to prevent.
   */
  const emit = (record: JournalEvent.Input) =>
    Effect.flatMap(Journal.Journal, (journal) => journal.emitDurable(record, options.owner)).pipe(
      Effect.catch((error) =>
        error.code === "fence_lost"
          ? Effect.interrupt
          : Effect.fail(storeFailure("the scheduler could not journal a record")(error))
      )
    )

  const record: Service["record"] = Effect.fn("PlanScheduler.record")((plan) =>
    Effect.gen(function*() {
      const store = yield* PlanStore.PlanStore
      const now = yield* Clock.currentTimeMillis
      const outcome = yield* store.record(plan, now).pipe(Effect.mapError(storeFailure("could not record the plan")))
      yield* emit(JournalRecords.planRecorded(source(`plan/${plan.planId}`), {
        planId: plan.planId,
        flow: plan.flow,
        digest: plan.digest,
        baseDigest: plan.baseDigest,
        generation: plan.generation,
        nodes: plan.nodes.length,
        outcome: outcome._tag
      }))
      return outcome
    })
  )

  const append: Service["append"] = Effect.fn("PlanScheduler.append")((plan) =>
    Effect.gen(function*() {
      const store = yield* PlanStore.PlanStore
      yield* store.append(plan).pipe(Effect.mapError(storeFailure("could not append the subgraph")))
      yield* emit(JournalRecords.subgraphAppended(source(`plan/${plan.planId}/${plan.generation}`), {
        planId: plan.planId,
        digest: plan.digest,
        baseDigest: plan.baseDigest,
        generation: plan.generation,
        nodeIds: Plan.generationNodes(plan).map((node) => node.id)
      }))
    })
  )

  const run: Service["run"] = Effect.fn("PlanScheduler.run")((initial) =>
    Effect.gen(function*() {
      const boundaries = yield* StepBoundary.StepBoundary
      const executor = yield* NodeExecutor
      const journal = yield* Journal.Journal
      const reconciler = Option.getOrElse(
        yield* Effect.serviceOption(Reconciliation.Reconciliation),
        Reconciliation.makeDefault
      )

      let plan = initial
      const states = new Map<string, NodeState>()
      const results = new Map<string, unknown>()
      const verdicts: Array<{ nodeId: string; verdict: Reconciliation.Verdict }> = []
      const appended: Array<string> = []
      /** Ordering edges reconciliation discovered; live for this run only. */
      const discovered = new Map<string, Array<string>>()
      const digestToNode = new Map<string, string>()
      const deviationSignatures = new Map<string, string>()
      const writers = new Map<string, string>()
      let cursor: number | undefined = undefined

      const stateOf = (node: Plan.PlanNode): NodeState => {
        const existing = states.get(node.id)
        if (existing !== undefined) return existing
        const fresh: NodeState = {
          status: "pending",
          outcome: "skipped",
          attempts: 0,
          rebases: 0,
          waited: 0,
          dispatchKey: ""
        }
        states.set(node.id, fresh)
        return fresh
      }

      /**
       * Which node produces each path. First declaration wins, matching the
       * plan compiler's declaration-order conflict resolution. A declared
       * removal counts: the plan produces that path's post-state, so pinning
       * it as an unproduced source input would measure the world at a moment
       * the plan is about to move.
       */
      const indexWriters = () => {
        for (const node of plan.nodes) {
          for (const path of [...node.effects.writes, ...node.effects.removes ?? []]) {
            if (!writers.has(path)) writers.set(path, node.id)
          }
        }
      }
      indexWriters()

      const prepare = (paths: ReadonlyArray<string>, what: string) =>
        boundaries.prepare({
          readSet: paths.map((path) => ({ path, digest: unmeasured })),
          writeSet: [],
          boundaryMode: "hard"
        }).pipe(
          Effect.mapError((cause) =>
            new SchedulerError({
              code: "boundary_unavailable",
              message: `the host could not measure ${what}`,
              cause
            })
          )
        )

      // The world, observed once: everything the plan reads that nothing in
      // the plan writes is pinned before the first dispatch and never
      // re-measured. That is the torn-run rule.
      const pinned = new Map<string, string>()
      const sourcePaths = [...new Set(plan.nodes.flatMap((node) => node.effects.reads))]
        .filter((path) => !writers.has(path))
        .sort()
      if (sourcePaths.length > 0) {
        const prepared = yield* prepare(sourcePaths, "the plan's source inputs")
        for (const entry of prepared.readSnapshot) pinned.set(entry.path, entry.digest)
      }

      const measure = (node: Plan.PlanNode) =>
        Effect.gen(function*() {
          const produced = node.effects.reads.filter((path) => !pinned.has(path))
          const measured = new Map(pinned)
          if (produced.length > 0) {
            // Produced paths are our own outputs, so measuring them once their
            // producer has settled is not re-observing the world.
            const prepared = yield* prepare(produced, `the inputs of ${node.id}`)
            for (const entry of prepared.readSnapshot) measured.set(entry.path, entry.digest)
          }
          return {
            readSet: node.effects.reads.map((path) => ({ path, digest: measured.get(path)! })),
            writeSet: node.effects.writes,
            // Declared removals travel with the boundary: they are what makes
            // an absent declared output legitimate rather than a defect.
            ...(node.effects.removes === undefined ? {} : { removes: node.effects.removes }),
            boundaryMode: node.effects.boundaryMode
          } satisfies FileBoundary
        })

      /**
       * The key a dispatch is recorded under: the node's own declaration
       * folded with the CONTENT of everything it consumes — the digests the
       * host just measured for its files, and the digest of each upstream
       * node's settled output value.
       *
       * Not the plan key. That key folds every upstream key transitively, so
       * an edit anywhere upstream re-ran everything below it even when the
       * edited node's output value was byte-identical. Bazel's
       * `ActionCacheChecker` stops invalidation at unchanged content, and
       * `StepKey.dispatchIdentity` is how this does.
       *
       * The plan key alone could never have been it either: two runs whose
       * input files differ declare the same graph, and serving one the other's
       * result is exactly the staleness the boundary exists to prevent.
       */
      const dispatchKeyFor = (node: Plan.PlanNode, boundary: FileBoundary) =>
        StepKey.dispatchIdentity({
          material: node.material,
          results: Object.fromEntries(results),
          hermetic: boundary
        }).pipe(
          /* v8 ignore next 3 -- every plan node is sealed (`Plan.annotate` refuses otherwise), a dependent of unsettled work never dispatches, and settled outputs are already durably serialized, so none of the three failures is reachable from here; the branch exists because the derivation is honest about its error channel */
          Effect.mapError((cause) =>
            new SchedulerError({ code: "key_uncomputable", message: `could not key ${node.id}`, cause })
          )
        )

      const dependenciesOf = (node: Plan.PlanNode): ReadonlyArray<string> => [
        ...node.dependsOn,
        ...discovered.get(node.id) ?? []
      ]

      const runtimeStrategyOf = (node: Plan.PlanNode): Plan.RuntimeStrategy =>
        node.conflicts.some((conflict) => conflict.runtime === "stop-merge") ? "stop-merge" : node.runtime

      const settle = (node: Plan.PlanNode, outcome: Outcome) =>
        Effect.gen(function*() {
          const state = stateOf(node)
          state.status = "settled"
          state.outcome = outcome
          yield* emit(JournalRecords.nodeSettled(source(`node/${node.id}/settled`), {
            planId: plan.planId,
            nodeId: node.id,
            planKey: node.key,
            dispatchKey: state.dispatchKey,
            outcome,
            attempts: state.attempts,
            rebases: state.rebases
          }))
        })

      const applyVerdict = (nodeId: string, verdict: Reconciliation.Verdict, trigger: string) =>
        Effect.gen(function*() {
          verdicts.push({ nodeId, verdict })
          yield* emit(JournalRecords.nodeReconciled(source(`node/${nodeId}/reconciled/${verdicts.length}`), {
            planId: plan.planId,
            nodeId,
            trigger,
            verdict
          }))
          if (verdict._tag === "Fail") {
            // The scheduler chooses the node it asks about, so a verdict always
            // names one it is tracking.
            const state = states.get(nodeId)!
            state.status = "settled"
            state.outcome = "failed"
            results.delete(nodeId)
            return
          }
          if (verdict._tag === "Reorder") {
            // Re-plan with the discovered dependency made explicit. It binds
            // work that has not dispatched yet — the deviating node already
            // ran, and rewriting history is what append-only forbids.
            // Persisting the edge is the caller's next elaboration; the
            // verdict is journaled so it can be.
            for (const owner of verdict.dependsOn) {
              if (states.get(owner)?.status === "settled") continue
              discovered.set(owner, [...new Set([...discovered.get(owner) ?? [], nodeId])])
            }
          }
          // `FactorOut` needs no graph surgery: two identical extracted steps
          // collapse to one key by themselves, so the second is a `clean`.
        })

      const dispatch = (node: Plan.PlanNode): Effect.Effect<Dispatched, SchedulerError, Requirements> =>
        Effect.gen(function*() {
          const state = stateOf(node)
          const inputs = Object.fromEntries(
            dependenciesOf(node).filter((id) => results.has(id)).map((id) => [id, results.get(id)])
          )
          while (true) {
            const boundary = yield* measure(node)
            const dispatchKey = yield* dispatchKeyFor(node, boundary)
            if (state.dispatchKey !== "" && state.dispatchKey !== dispatchKey) {
              yield* emit(JournalRecords.nodeInvalidated(source(`node/${node.id}/${state.attempts}/invalidated`), {
                planId: plan.planId,
                nodeId: node.id,
                planKey: node.key,
                from: state.dispatchKey,
                to: dispatchKey,
                reason: "measured-inputs-changed"
              }))
            }
            state.dispatchKey = dispatchKey
            state.attempts = state.attempts + 1
            yield* emit(JournalRecords.nodeScheduled(source(`node/${node.id}/${state.attempts}`), {
              planId: plan.planId,
              nodeId: node.id,
              kind: node.kind,
              planKey: node.key,
              dispatchKey,
              attempt: state.attempts,
              priority: node.priority,
              waited: state.waited
            }))
            digestToNode.set(yield* Effect.orDie(digestOf(dispatchKey)), node.id)
            const ran = yield* Ref.make(false)
            const exit = yield* ActionPersistence.make({
              runId: options.runId,
              owner: options.owner,
              sourceId: `${options.sourceId}/node/${node.id}`,
              execute: () =>
                Ref.set(ran, true).pipe(
                  Effect.andThen(executor.execute({ node, attempt: state.attempts, boundary, inputs }))
                )
            })({ action: {}, attempt: state.attempts, key: dispatchKey, tier: "sealed", metadata: boundary }).pipe(
              Effect.exit
            )
            if (Exit.isSuccess(exit)) {
              results.set(node.id, exit.value)
              return { outcome: (yield* Ref.get(ran)) ? "built" : "clean" } as const
            }
            if (!isConflict(exit.cause)) return { outcome: "failed" } as const
            const strategy = runtimeStrategyOf(node)
            if (strategy === "delay-rebase" && state.rebases < rebaseLimit) {
              // Hold the dependents — they are not ready while this node is
              // pending — and re-execute against the newly recorded base. The
              // next turn of the loop re-measures, which re-keys, which is a
              // new attempt rather than a retry of the old identity.
              state.rebases = state.rebases + 1
              continue
            }
            return { outcome: "conflicted", strategy } as const
          }
        })

      /**
       * `stop-merge`: the losing action is stopped and both lanes are routed
       * through an explicit merge node appended to the SAME plan, as an
       * ordinary elaboration. `docs/specs/Concepts/Worktree Lanes.md`'s
       * restart-or-fail landing contract governs the merge critical section,
       * so the merge node carries no rebase budget of its own: it lands, or
       * the run has a failed node.
       */
      const appendMerge = (node: Plan.PlanNode) =>
        Effect.gen(function*() {
          const winners = node.conflicts.map((conflict) => conflict.with).filter((id) => results.has(id))
          const mergeId = `${node.id}+merge`
          const grown = yield* Plan.append(plan, [{
            id: mergeId,
            kind: "merge",
            material: {
              version: "flows/key-material/v1",
              kind: "sealed",
              body: { merge: { stopped: node.id, winners } },
              inputs: winners.map((id) => ({ _tag: "Pending" as const, from: id })),
              layers: [],
              capabilities: []
            },
            effects: node.effects
          }]).pipe(
            /* v8 ignore next 7 -- the merge id derives from a node id that appears once, its only dependencies are nodes that already produced results, and its write set is ordered behind them, so none of `Plan.append`'s four refusals is reachable */
            Effect.mapError((cause) =>
              new SchedulerError({
                code: "elaboration_failed",
                message: `could not append the merge node for ${node.id}`,
                cause
              })
            )
          )
          plan = grown
          indexWriters()
          appended.push(mergeId)
          yield* append(grown)
        })

      /**
       * The first consumer `flows.engine.expected-set-deviation` has ever had.
       * The events are read from the journal rather than from the attempt row
       * on purpose: a deviation is a durable, replayable fact, and consuming
       * the fact keeps this seam usable by anything else that reads the
       * journal.
       *
       * Two properties the drain owes the reconciler, both of them about not
       * letting arrival order decide a verdict:
       *
       * 1. **Attribute the whole page before judging any of it.** Deviating on
       *    the same paths is a *symmetric* fact — two steps that both ran
       *    `npm install` — so registering each signature as the entry was
       *    judged answered the same situation two different ways: the first
       *    node saw no peer and was failed, and only the second was factored
       *    out. Every deviation on the page is attributed first, so both sides
       *    of a pair see each other.
       * 2. **Drain the journal, not one page of it.** A wide round journals
       *    more records than one page holds, and the last round is the one that
       *    matters: nothing follows it to pick up what a single page left
       *    behind, so a deviation past the cursor would never reach the seam.
       */
      const drainDeviations = Effect.gen(function*() {
        while (true) {
          const page = yield* journal.entries({
            runId: options.runId as JournalEvent.RunId,
            ...(cursor === undefined ? {} : { after: cursor as JournalEvent.Seq }),
            limit: 512
          }).pipe(Effect.mapError(storeFailure("could not read the run's journal")))
          const attributed: Array<{ nodeId: string; signature: string; payload: typeof DeviationPayload.Type }> = []
          for (const entry of page.entries) {
            cursor = entry.seq
            if (entry.eventType !== "flows.engine.expected-set-deviation") continue
            const payload = decodeDeviation(entry.payload)
            if (Option.isNone(payload)) continue
            const nodeId = digestToNode.get(payload.value.stepKeyDigest)
            if (nodeId === undefined) continue
            const signature = [...payload.value.paths].sort().join(" ")
            deviationSignatures.set(nodeId, signature)
            attributed.push({ nodeId, signature, payload: payload.value })
          }
          for (const { nodeId, payload, signature } of attributed) {
            const alsoDeviatedBy = [...deviationSignatures.entries()]
              .filter(([other, otherSignature]) => other !== nodeId && otherSignature === signature)
              .map(([other]) => other)
            const declaredBy = Object.fromEntries(
              payload.paths.flatMap((path) => {
                const owner = writers.get(path)
                return owner === undefined ? [] : [[path, owner] as const]
              })
            )
            const verdict = yield* reconciler.onDeviation({
              nodeId,
              keyDigest: payload.stepKeyDigest,
              attempt: payload.attempt,
              paths: payload.paths,
              diffIdentity: payload.diffIdentity,
              declaredBy,
              alsoDeviatedBy
            })
            yield* applyVerdict(nodeId, verdict, "deviation")
          }
          if (!page.hasMore) break
        }
      })

      while ([...states.values()].filter((state) => state.status === "settled").length < plan.nodes.length) {
        const pending = plan.nodes.filter((node) => stateOf(node).status === "pending")
        const blocked: Array<Plan.PlanNode> = []
        const ready: Array<Plan.PlanNode> = []
        for (const node of pending) {
          const dependencies = dependenciesOf(node).map((id) => states.get(id))
          if (dependencies.some((state) => state === undefined || state.status === "pending")) continue
          if (dependencies.some((state) => state!.outcome === "failed" || state!.outcome === "skipped")) {
            blocked.push(node)
            continue
          }
          ready.push(node)
        }
        // Halt, not continue-on-failure: a dependent of failed work never
        // dispatches. `docs/specs/Concepts/Failure Policy.md`'s two open
        // questions stay open — this is the conservative half both answers
        // agree on.
        for (const node of blocked) yield* settle(node, "skipped")
        if (blocked.length > 0) continue
        /* v8 ignore next -- the plan compiler rejects cycles, so a round with pending work and nothing ready is unreachable */
        if (ready.length === 0) break

        const order = new Map(plan.nodes.map((node, index) => [node.id, index]))
        const admitted: Array<Plan.PlanNode> = []
        let agents = 0
        const contenders = [...ready].sort((left, right) => {
          const delta = (right.priority + stateOf(right).waited) - (left.priority + stateOf(left).waited)
          return delta === 0 ? order.get(left.id)! - order.get(right.id)! : delta
        })
        for (const node of contenders) {
          const isAgent = node.kind === "agent"
          if (admitted.length >= stepCap || (isAgent && agents >= agentCap)) continue
          if (isAgent) agents = agents + 1
          admitted.push(node)
        }
        for (const node of ready) {
          if (!admitted.includes(node)) stateOf(node).waited = stateOf(node).waited + 1
        }

        const dispatched = yield* Effect.forEach(admitted, dispatch, { concurrency: "unbounded" })
        for (let index = 0; index < admitted.length; index++) {
          const node = admitted[index]!
          const result = dispatched[index]!
          if (result.outcome !== "conflicted") {
            yield* settle(node, result.outcome)
            continue
          }
          if (result.strategy === "stop-merge") {
            yield* settle(node, "skipped")
            yield* appendMerge(node)
            continue
          }
          const state = stateOf(node)
          const verdict = yield* reconciler.onConflict({
            nodeId: node.id,
            keyDigest: state.dispatchKey,
            attempt: state.attempts,
            rebases: state.rebases,
            strategy: result.strategy,
            conflictsWith: node.conflicts.map((conflict) => conflict.with)
          })
          yield* settle(node, "failed")
          yield* applyVerdict(node.id, verdict, "materialization-conflict")
        }
        yield* drainDeviations
      }

      return {
        planId: plan.planId,
        digest: plan.digest,
        settlements: plan.nodes.map((node) => {
          const state = stateOf(node)
          return {
            nodeId: node.id,
            planKey: node.key,
            dispatchKey: state.dispatchKey,
            outcome: state.outcome,
            attempts: state.attempts,
            rebases: state.rebases
          }
        }),
        results: Object.fromEntries(results),
        verdicts,
        appended
      }
    })
  )

  return { record, append, run }
}

/**
 * Provides a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<PlanScheduler> => Layer.succeed(PlanScheduler, make(options))
