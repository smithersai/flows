/**
 * The probabilistic-selection seam: guesses may schedule work; only real
 * dependencies decide truth.
 *
 * `docs/specs/Concepts/Probabilistic Selection.md` proposes learning, from run
 * history, which changes *tend to* affect which flows, and letting those
 * guesses do exactly three things: suggest extra work, postpone work that
 * almost never fails, and order the queue. This module is the engine-store
 * half of the proposal: the belief and verdict types, the pluggable
 * `Selection` service, and the deterministic default layers. `PlanScheduler`
 * is the one consumer, and it offers only **sinks** — nodes nothing in the
 * plan depends on — because deferring a node something consumes would block
 * or corrupt its consumers. Meta's Predictive Test Selection (ICSE-SEIP 2019)
 * skips tests under exactly this restriction: tests are sinks.
 *
 * Four laws bound what a verdict may do, and the scheduler's tests assert
 * each:
 *
 * 1. A verdict never enters key material and never changes a cache row: an
 *    admitted node's step key and cached result are computed exactly as if
 *    selection did not exist.
 * 2. `deferred` is never passed. The node does not execute, writes no cache
 *    row, and is journaled as a debt (`flows.engine.selection-deferred`)
 *    that a later guess-free pass repays.
 * 3. Only sinks are deferrable. A Defer or Propose verdict naming anything
 *    else is ignored and journaled as an inconsistency observation —
 *    Skyframe's `GraphInconsistencyReceiver` shape: note it, decide, never
 *    wire the detector to /dev/null.
 * 4. Guesses add or postpone, never remove. A node the plan requires runs
 *    exactly as today, and the run-level `full` override restores full
 *    execution the way `--fresh` ignores the cache.
 *
 * Pluggability is dependency injection at the owning seam, exactly as
 * `Reconciliation` beside it: {@link layerNoop} admits everything and is the
 * behavioral default when no layer is provided; {@link layerHeuristic} is a
 * pure, deterministic function of the pinned belief snapshot; a model-backed
 * selector is a different `Layer`, lives outside this package, and this
 * package must not grow a model dependency.
 *
 * Deliberately absent from v1, recorded here so the absences read as
 * decisions rather than oversights: plan-card rendering of
 * `deferred`/`proposed` rows, the model-backed selection layer, belief
 * training and decay, read-set proposing, plan-level risk scoring, and
 * auto-appending proposed nodes — a `Propose` verdict is journaled and
 * surfaced, never executed.
 *
 * @since 0.1.0
 */
import { Journal, type JournalEvent } from "@smthrs/journal-next"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const Confidence = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1)
)

/**
 * A recorded guess with a fixed shape: "changes matching this path pattern
 * tend to affect this flow". It is a belief, not a dependency — it carries
 * confidence and evidence, and training moves the confidence; nothing here
 * ever enters a step key.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SuspectedEdge = Schema.Struct({
  /** The path glob changed files are matched against. */
  scope: Schema.NonEmptyString,
  /** The flow or step name the guess says the change affects. */
  affects: Schema.NonEmptyString,
  /** In `[0, 1]`; moved by outcomes, never by hand. */
  confidence: Confidence,
  /** The edge is inert until the snapshot's `pinnedAtMs` reaches this. */
  validFromMs: Schema.Number,
  /** References to the journal facts the guess was learned from. */
  evidence: Schema.Array(Schema.String)
})

/**
 * The value form of {@link SuspectedEdge}.
 *
 * @since 0.1.0
 * @category models
 */
export type SuspectedEdge = typeof SuspectedEdge.Type

/**
 * The suspected edges in force for one run, pinned before planning. Pinning
 * is what keeps selection a pure function of data in hand: a belief updated
 * mid-run cannot change what this run defers.
 *
 * @since 0.1.0
 * @category schemas
 */
export const BeliefSnapshot = Schema.Struct({
  pinnedAtMs: Schema.Number,
  edges: Schema.Array(SuspectedEdge)
})

/**
 * The value form of {@link BeliefSnapshot}.
 *
 * @since 0.1.0
 * @category models
 */
export type BeliefSnapshot = typeof BeliefSnapshot.Type

/**
 * What selection decided: admit the work (the default), postpone it to a
 * guess-free pass, or propose a flow no real dependency reaches.
 *
 * The design draft names this union `SelectionVerdict`; here the `Selection`
 * namespace carries that prefix, so the export is `Verdict`, the same shape
 * `Reconciliation.Verdict` takes beside it.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Verdict = Schema.Union([
  Schema.TaggedStruct("Admit", {}),
  Schema.TaggedStruct("Defer", { edge: SuspectedEdge, likelihood: Confidence }),
  Schema.TaggedStruct("Propose", { flow: Schema.NonEmptyString, edge: SuspectedEdge, confidence: Confidence })
])

/**
 * The value form of {@link Verdict}.
 *
 * @since 0.1.0
 * @category models
 */
export type Verdict = typeof Verdict.Type

/**
 * Deferral policy, inherited per directory like cache freshness windows.
 *
 * @since 0.1.0
 * @category models
 */
export interface Policy {
  /**
   * A sink whose best matched likelihood is strictly below this threshold is
   * deferred. Zero defers nothing; a likelihood exactly at the threshold is
   * admitted.
   */
  readonly deferBelow: number
}

/**
 * One deferrable candidate the scheduler offers: a plan node nothing in the
 * plan depends on.
 *
 * @since 0.1.0
 * @category models
 */
export interface Candidate {
  readonly nodeId: string
  /** The plan-time key: the identity the scheduler already holds. */
  readonly planKey: string
}

/**
 * Everything one selection consult sees. The scheduler builds it once per
 * run, so a verdict is a pure function of the changed set, the plan's shape,
 * and the pinned beliefs.
 *
 * @since 0.1.0
 * @category models
 */
export interface Input {
  /** Paths this change touched, matched against edge scopes. */
  readonly changed: ReadonlyArray<string>
  /** The only deferrable candidates: plan nodes with no dependents. */
  readonly sinks: ReadonlyArray<Candidate>
  /**
   * Every name the plan accounts for: its flow and its node ids. An edge
   * whose `affects` names none of these reaches work the plan cannot see,
   * which is what a `Propose` verdict records.
   */
  readonly present: ReadonlyArray<string>
  /** The belief snapshot pinned before planning. */
  readonly beliefs: BeliefSnapshot
  readonly policy: Policy
}

/**
 * One returned verdict. `nodeId` names the offered candidate for `Admit` and
 * `Defer`; a `Propose` names work outside the plan, so there it carries the
 * proposed flow's name instead of a plan node id.
 *
 * @since 0.1.0
 * @category models
 */
export interface Selected {
  readonly nodeId: string
  readonly verdict: Verdict
}

/**
 * The pluggable selector.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly select: (input: Input) => Effect.Effect<ReadonlyArray<Selected>>
}

/**
 * Service tag for the probabilistic-selection seam.
 *
 * @since 0.1.0
 * @category services
 */
export class Selection extends Context.Service<Selection, Service>()("flows/engine-store/Selection") {}

/**
 * Names a {@link Service} implementation as a selector.
 *
 * It is the identity function: the value is checked against the interface at
 * its definition site, which is where a wrong-shaped selector should be
 * reported rather than at whichever layer eventually provides it.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (service: Service): Service => service

/**
 * Provides a {@link Service} as the {@link Selection} seam.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (service: Service): Layer.Layer<Selection> => Layer.succeed(Selection, service)

/**
 * Admits everything. This is the behavioral default: with no `Selection`
 * layer provided the scheduler falls back to it, and a run under it is
 * byte-identical to a run before this seam existed — same keys, same cache
 * rows, same journal.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Service => ({
  select: Effect.fn("Selection.select")((input) =>
    Effect.succeed(
      input.sinks.map((candidate): Selected => ({ nodeId: candidate.nodeId, verdict: { _tag: "Admit" } }))
    )
  )
})

/**
 * Provides the selector that admits everything.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop: Layer.Layer<Selection> = Layer.sync(Selection, makeNoop)

/**
 * Compiles a path glob and tests one path against it: `**` crosses path
 * separators, `*` and `?` stay within a segment, everything else is literal.
 * The whole path must match, so `packages/engine/src/**` selects everything
 * under that directory and nothing beside it.
 */
const matchesScope = (scope: string, path: string): boolean => {
  const expression = scope
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => part.split("?").map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]"))
        .join("[^/]*")
    )
    .join(".*")
  return new RegExp(`^${expression}$`).test(path)
}

/**
 * The deterministic default heuristics: pure, no IO, no model calls, a
 * function of nothing but its input.
 *
 * An edge is *live* when its `validFromMs` has been reached at the
 * snapshot's `pinnedAtMs` and some changed path matches its scope glob. A
 * live edge yields likelihood equal to its confidence. A sink whose best
 * likelihood is strictly below `policy.deferBelow` is deferred under its
 * best edge; a sink no live edge names — or one at or above the threshold —
 * is admitted. A live edge whose `affects` names nothing the plan contains
 * proposes that flow, once per flow under its highest-confidence edge.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeHeuristic = (): Service => ({
  select: Effect.fn("Selection.select")((input) =>
    Effect.sync(() => {
      const live = input.beliefs.edges.filter((edge) =>
        edge.validFromMs <= input.beliefs.pinnedAtMs
        && input.changed.some((path) => matchesScope(edge.scope, path))
      )
      const verdicts: Array<Selected> = []
      for (const candidate of input.sinks) {
        let best: SuspectedEdge | undefined = undefined
        for (const edge of live) {
          if (edge.affects !== candidate.nodeId) continue
          if (best === undefined || edge.confidence > best.confidence) best = edge
        }
        verdicts.push(
          best !== undefined && best.confidence < input.policy.deferBelow
            ? { nodeId: candidate.nodeId, verdict: { _tag: "Defer", edge: best, likelihood: best.confidence } }
            : { nodeId: candidate.nodeId, verdict: { _tag: "Admit" } }
        )
      }
      const present = new Set(input.present)
      const proposals = new Map<string, SuspectedEdge>()
      for (const edge of live) {
        if (present.has(edge.affects)) continue
        const existing = proposals.get(edge.affects)
        if (existing === undefined || edge.confidence > existing.confidence) proposals.set(edge.affects, edge)
      }
      for (const [flow, edge] of proposals) {
        verdicts.push({ nodeId: flow, verdict: { _tag: "Propose", flow, edge, confidence: edge.confidence } })
      }
      return verdicts
    })
  )
})

/**
 * Provides the deterministic default heuristics.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerHeuristic: Layer.Layer<Selection> = Layer.sync(Selection, makeHeuristic)

/**
 * One unpaid deferral: the work a guess postponed, with everything a
 * guess-free follow-up needs to execute exactly it — the node, its
 * content-addressed plan key, the edge that caused the postponement, and the
 * journal position the debt was recorded at.
 *
 * @since 0.1.0
 * @category schemas
 */
export const DebtEntry = Schema.Struct({
  planId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  /** The plan-time key: the content-addressed handle repayment settles against. */
  planKey: Schema.NonEmptyString,
  edge: SuspectedEdge,
  likelihood: Schema.Number,
  /** Journal provenance: the durable sequence the deferral was recorded at. */
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * The value form of {@link DebtEntry}.
 *
 * @since 0.1.0
 * @category models
 */
export type DebtEntry = typeof DebtEntry.Type

/**
 * The `flows.engine.selection-deferred` payload the scheduler writes. Read
 * tolerantly: `likelihood` stays an unrefined number here — unlike the
 * `Verdict` union's `[0, 1]` refinement — so a historically journaled
 * out-of-range value cannot silently drop a real debt.
 */
const DeferredPayload = Schema.Struct({
  planId: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  planKey: Schema.NonEmptyString,
  edge: SuspectedEdge,
  likelihood: Schema.Number
})

const decodeDeferred = Schema.decodeUnknownOption(DeferredPayload)

/** The slice of a `flows.engine.node-settled` payload repayment reads. */
const SettledPayload = Schema.Struct({
  planKey: Schema.NonEmptyString,
  outcome: Schema.String
})

const decodeSettled = Schema.decodeUnknownOption(SettledPayload)

/**
 * Lists the run's unpaid deferrals by folding the journal: every
 * `flows.engine.selection-deferred` record opens a debt under its plan key,
 * and a later `node-settled` under the same key with a real outcome —
 * `built`, `clean`, or `failed` — closes it. A `skipped` settlement does not:
 * that work never ran, so it is still owed. A `failed` one does: the
 * guess-free pass executed the work and surfaced the miss, which is the
 * training signal the spec asks for.
 *
 * The fold reads exactly one run's journal, so only a settlement journaled
 * under the same `runId` closes a debt — the guess-free pass is the deferring
 * run driven again under the `full` override. A recertification run holds
 * its own runId and is invisible here; a cross-run repayment query is future
 * work.
 *
 * The journal is read directly rather than projected into a table, for the
 * same reason the scheduler consumes deviations from it: a deferral is a
 * durable, replayable fact, and a second store would be a cache of one.
 *
 * @since 0.1.0
 * @category queries
 */
export const debt = Effect.fn("Selection.debt")((runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const owed = new Map<string, DebtEntry>()
    let cursor: number | undefined = undefined
    while (true) {
      const page: Journal.EntriesPage = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(cursor === undefined ? {} : { after: cursor as JournalEvent.Seq }),
        limit: 512
      })
      for (const entry of page.entries) {
        cursor = entry.seq
        if (entry.eventType === "flows.engine.selection-deferred") {
          const payload = decodeDeferred(entry.payload)
          if (Option.isNone(payload)) continue
          owed.set(payload.value.planKey, { ...payload.value, seq: entry.seq })
          continue
        }
        if (entry.eventType !== "flows.engine.node-settled") continue
        const payload = decodeSettled(entry.payload)
        if (Option.isNone(payload)) continue
        const outcome = payload.value.outcome
        if (outcome === "built" || outcome === "clean" || outcome === "failed") {
          owed.delete(payload.value.planKey)
        }
      }
      if (!page.hasMore) break
    }
    return [...owed.values()] as ReadonlyArray<DebtEntry>
  })
)
