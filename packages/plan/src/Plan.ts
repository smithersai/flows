/**
 * The plan: a node graph with every step key computed, inert until run.
 *
 * `docs/specs/Specs/Object Model.md` defines a `Plan` as exactly that, and
 * `docs/specs/Concepts/Build Phases.md` makes the way it is produced a law —
 * **planning performs no I/O**. Everything in this module is therefore a pure
 * function of declarations plus the injected `Crypto` service: no filesystem,
 * no clock, no network. A node's key is a function of what it consumes, so an
 * edited declaration re-keys that node and everything downstream of it, and
 * nothing else. That is the entire invalidation mechanism —
 * `docs/specs/Concepts/Hot Reload.md` ("invalidation is re-keying") and
 * `docs/specs/Concepts/Engine Hardening Round 1.md`, which **rejects**
 * Skyframe's reverse-dependency index and invalidating node visitor outright
 * because content addressing subsumes them. There is no reverse-dep index in
 * this file, and there must never be one.
 *
 * Growth is append-only (`docs/specs/Specs/Plan.md`): {@link append} adds a
 * pre-keyed subgraph to the same plan and never rewrites a node already in it.
 *
 * @since 0.1.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as KeyMaterial from "./KeyMaterial.ts"
import * as StepKey from "./StepKey.ts"

/**
 * The storage-facing form of a computed key. `StepKey.content` produces the
 * branded `Key`; a persisted plan carries the same string, validated.
 *
 * @since 0.1.0
 * @category schemas
 */
export const KeyDigest = Schema.String.check(Schema.isPattern(/^key1_[0-9a-f]{64}$/))

/**
 * What a node does to the world, declared. Paths only — measuring them is
 * run-time work, so a digest here would break the no-I/O law.
 *
 * @since 0.1.0
 * @category schemas
 */
export const NodeEffects = Schema.Struct({
  reads: Schema.Array(Schema.String),
  writes: Schema.Array(Schema.String),
  boundaryMode: Schema.Literals(["hard", "expected"])
})

/**
 * The value form of {@link NodeEffects}.
 *
 * @since 0.1.0
 * @category models
 */
export type NodeEffects = typeof NodeEffects.Type

/**
 * The plan-time write-conflict strategies of
 * `docs/specs/Concepts/Effect Taxonomy.md`.
 *
 * @since 0.1.0
 * @category schemas
 */
export const PairStrategy = Schema.Literals(["serialize", "lane", "fail"])

/**
 * The value form of {@link PairStrategy}.
 *
 * @since 0.1.0
 * @category models
 */
export type PairStrategy = typeof PairStrategy.Type

/**
 * The runtime half of a conflict annotation, added by
 * `docs/specs/Concepts/Runtime Conflict Strategies.md`: what the scheduler
 * does when the overlap the plan predicted actually bites, or when a
 * scheduled node's inputs are invalidated under it.
 *
 * @since 0.1.0
 * @category schemas
 */
export const RuntimeStrategy = Schema.Literals(["delay-rebase", "stop-merge"])

/**
 * The value form of {@link RuntimeStrategy}.
 *
 * @since 0.1.0
 * @category models
 */
export type RuntimeStrategy = typeof RuntimeStrategy.Type

/**
 * One resolved overlap between two writers that no dependency path already
 * orders. Conflict is a property of the PAIR, not of one declaration.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ConflictAnnotation = Schema.Struct({
  with: Schema.NonEmptyString,
  paths: Schema.Array(Schema.String),
  strategy: PairStrategy,
  runtime: RuntimeStrategy
})

/**
 * The value form of {@link ConflictAnnotation}.
 *
 * @since 0.1.0
 * @category models
 */
export type ConflictAnnotation = typeof ConflictAnnotation.Type

/**
 * A keyed node of the plan.
 *
 * `dependsOn` is the *edge* set: material references plus any ordering edge a
 * `serialize` verdict added. Ordering edges are deliberately NOT part of the
 * key — a node serialized behind another still computes the same result, so
 * re-keying it would throw away a legitimate cache hit.
 *
 * `strategy` and `runtime` are this declaration's own preferences, recorded so
 * a later elaboration can resolve a pair against them without re-reading the
 * flow source.
 *
 * @since 0.1.0
 * @category schemas
 */
export const PlanNode = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["step", "agent", "merge"]),
  key: KeyDigest,
  material: KeyMaterial.KeyMaterial,
  effects: NodeEffects,
  dependsOn: Schema.Array(Schema.NonEmptyString),
  conflicts: Schema.Array(ConflictAnnotation),
  strategy: PairStrategy,
  runtime: RuntimeStrategy,
  priority: Schema.Int,
  generation: Schema.Int
})

/**
 * The value form of {@link PlanNode}.
 *
 * @since 0.1.0
 * @category models
 */
export type PlanNode = typeof PlanNode.Type

/**
 * A plan: the whole keyed graph plus the digest an approval binds to.
 *
 * `baseDigest` is the digest at generation 0 — what a human approved and what
 * a `RUNNING` run pins per `docs/specs/Concepts/Hot Reload.md`. `digest`
 * advances with every appended elaboration.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Plan = Schema.Struct({
  planId: Schema.NonEmptyString,
  flow: Schema.NonEmptyString,
  generation: Schema.Int,
  baseDigest: KeyDigest,
  digest: KeyDigest,
  nodes: Schema.Array(PlanNode)
})

/**
 * The value form of {@link Plan}.
 *
 * @since 0.1.0
 * @category models
 */
export type Plan = typeof Plan.Type

/**
 * What a planner hands {@link compile}: a node without its key.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeDraft {
  readonly id: string
  readonly material: KeyMaterial.KeyMaterial
  readonly effects: NodeEffects
  readonly kind?: PlanNode["kind"] | undefined
  readonly priority?: number | undefined
  /** This declaration's preferred plan-time verdict for a detected overlap. */
  readonly conflictStrategy?: PairStrategy | undefined
  /** This declaration's preferred runtime response. */
  readonly runtimeStrategy?: RuntimeStrategy | undefined
}

/**
 * A graph the compiler refuses.
 *
 * @since 0.1.0
 * @category errors
 */
export class PlanError extends Schema.TaggedErrorClass<PlanError>()("flows/plan/PlanError", {
  code: Schema.Literals(["cycle", "unknown_dependency", "duplicate_node", "overlap_forbidden"]),
  message: Schema.String
}) {}

/**
 * Resolves the pair's verdict. `fail` dominates — a flow that promised
 * disjointness must not be quietly serialized — then `lane`, because "when
 * either writer requests `lane`, both receive lane annotations"; `serialize`
 * is the default whenever an overlap is detected at all.
 *
 * @private
 */
const pairStrategy = (left: PairStrategy, right: PairStrategy): PairStrategy =>
  left === "fail" || right === "fail" ? "fail" : left === "lane" || right === "lane" ? "lane" : "serialize"

/**
 * `stop-merge` dominates for the same reason `lane` does: it is the strategy a
 * declaration opts into, and a pair cannot half-merge.
 *
 * @private
 */
const pairRuntime = (left: RuntimeStrategy, right: RuntimeStrategy): RuntimeStrategy =>
  left === "stop-merge" || right === "stop-merge" ? "stop-merge" : "delay-rebase"

/** @private */
const overlap = (left: NodeEffects, right: NodeEffects): ReadonlyArray<string> =>
  left.writes.filter((path) => right.writes.includes(path))

/** @private */
type Ordered =
  | { readonly ok: true; readonly drafts: ReadonlyArray<NodeDraft> }
  | { readonly ok: false; readonly error: PlanError }

/**
 * Topologically orders drafts by their MATERIAL dependencies — the only edges
 * that exist before keys do.
 *
 * @private
 */
const topological = (drafts: ReadonlyArray<NodeDraft>, known: ReadonlySet<string>): Ordered => {
  const byId = new Map(drafts.map((draft) => [draft.id, draft]))
  const ordered: Array<NodeDraft> = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (draft: NodeDraft): PlanError | undefined => {
    const mark = state.get(draft.id)
    if (mark === "done") return undefined
    if (mark === "visiting") return new PlanError({ code: "cycle", message: `Plan cycle through node ${draft.id}` })
    state.set(draft.id, "visiting")
    for (const dependency of KeyMaterial.dependencies(draft.material)) {
      if (known.has(dependency)) continue
      const next = byId.get(dependency)
      if (next === undefined) {
        return new PlanError({
          code: "unknown_dependency",
          message: `Node ${draft.id} depends on unknown node ${dependency}`
        })
      }
      const failure = visit(next)
      if (failure !== undefined) return failure
    }
    state.set(draft.id, "done")
    ordered.push(draft)
    return undefined
  }
  for (const draft of drafts) {
    const failure = visit(draft)
    if (failure !== undefined) return { ok: false, error: failure }
  }
  return { ok: true, drafts: ordered }
}

/**
 * Transitive dependency closure, computed in plan order. Every node's
 * dependencies precede it, so one pass suffices.
 *
 * @private
 */
const reachable = (nodes: ReadonlyArray<PlanNode>): Map<string, Set<string>> => {
  const closure = new Map<string, Set<string>>()
  for (const node of nodes) {
    const set = new Set<string>()
    for (const dependency of node.dependsOn) {
      set.add(dependency)
      /* v8 ignore next -- plan order guarantees a dependency was closed before its dependent, so the fallback is unreachable for any graph `topological` accepted */
      for (const transitive of closure.get(dependency) ?? []) set.add(transitive)
    }
    closure.set(node.id, set)
  }
  return closure
}

/**
 * Detects write overlaps and annotates the conflicting pair, adding the
 * ordering edge a `serialize` verdict implies. Nodes already ordered by a
 * dependency path are not conflicts.
 *
 * Nodes are visited in plan order, so a `serialize` edge always points from
 * the earlier declaration to the later one and can never close a cycle. Nodes
 * in `frozen` were recorded by an earlier generation: append-only means their
 * rows are never rewritten, so a pair discovered during elaboration is
 * annotated on the NEW node only — which is also the node the ordering edge
 * lands on, and the annotation names the other side either way.
 *
 * @private
 */
const annotate = (
  nodes: ReadonlyArray<PlanNode>,
  frozen: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<PlanNode>, PlanError> =>
  Effect.gen(function*() {
    const closure = reachable(nodes)
    const conflicts = new Map<string, Array<ConflictAnnotation>>()
    const ordering = new Map<string, Array<string>>()
    for (let index = 0; index < nodes.length; index++) {
      const later = nodes[index]!
      if (frozen.has(later.id)) continue
      for (let before = 0; before < index; before++) {
        const earlier = nodes[before]!
        const paths = overlap(earlier.effects, later.effects)
        if (paths.length === 0) continue
        if (closure.get(later.id)!.has(earlier.id)) continue
        const strategy = pairStrategy(earlier.strategy, later.strategy)
        const runtime = pairRuntime(earlier.runtime, later.runtime)
        if (strategy === "fail") {
          return yield* Effect.fail(
            new PlanError({
              code: "overlap_forbidden",
              message: `Nodes ${earlier.id} and ${later.id} both write ${paths.join(", ")}`
            })
          )
        }
        const annotation = (other: string): ConflictAnnotation => ({ with: other, paths, strategy, runtime })
        if (!frozen.has(earlier.id)) {
          conflicts.set(earlier.id, [...conflicts.get(earlier.id) ?? [], annotation(later.id)])
        }
        conflicts.set(later.id, [...conflicts.get(later.id) ?? [], annotation(earlier.id)])
        if (strategy === "serialize") {
          ordering.set(later.id, [...ordering.get(later.id) ?? [], earlier.id])
          closure.get(later.id)!.add(earlier.id)
        }
      }
    }
    return nodes.map((node) => {
      if (frozen.has(node.id)) return node
      const added = ordering.get(node.id) ?? []
      return {
        ...node,
        conflicts: conflicts.get(node.id) ?? [],
        dependsOn: added.length === 0 ? node.dependsOn : [...node.dependsOn, ...added]
      }
    })
  })

/**
 * The plan's digest: what an approval binds to. It covers node identity,
 * every computed key, the edge set, and the resolved conflict annotations —
 * everything the plan card renders and a human therefore agreed to.
 *
 * @private
 */
const digestOf = (
  planId: string,
  flow: string,
  nodes: ReadonlyArray<PlanNode>
): Effect.Effect<string, Schema.SchemaError, Crypto.Crypto> =>
  StepKey.content({
    body: { kind: "plan", planId, flow },
    inputs: {
      nodes: nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        key: node.key,
        dependsOn: node.dependsOn,
        conflicts: node.conflicts,
        effects: node.effects,
        priority: node.priority
      }))
    },
    layers: [],
    capabilities: {}
  })

/** @private */
const keyNodes = (
  drafts: ReadonlyArray<NodeDraft>,
  existing: ReadonlyArray<PlanNode>,
  generation: number
): Effect.Effect<
  ReadonlyArray<PlanNode>,
  PlanError | StepKey.KeyMaterialError | Schema.SchemaError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const digests: Record<string, string> = {}
    const known = new Set<string>()
    for (const node of existing) {
      digests[node.id] = node.key
      known.add(node.id)
    }
    for (const draft of drafts) {
      if (known.has(draft.id)) {
        return yield* Effect.fail(
          new PlanError({ code: "duplicate_node", message: `Node ${draft.id} is already in the plan` })
        )
      }
      known.add(draft.id)
    }
    const sorted = topological(drafts, new Set(existing.map((node) => node.id)))
    if (!sorted.ok) return yield* Effect.fail(sorted.error)
    const keyed: Array<PlanNode> = []
    for (const draft of sorted.drafts) {
      const key = yield* StepKey.fromKeyMaterial(draft.material, digests)
      digests[draft.id] = key
      keyed.push({
        id: draft.id,
        kind: draft.kind ?? "step",
        key,
        material: draft.material,
        effects: draft.effects,
        dependsOn: KeyMaterial.dependencies(draft.material),
        conflicts: [],
        strategy: draft.conflictStrategy ?? "serialize",
        runtime: draft.runtimeStrategy ?? "delay-rebase",
        priority: draft.priority ?? 0,
        generation
      })
    }
    return keyed
  })

/**
 * Compiles drafts into a plan: topological order, dependency-digest
 * substitution, overlap annotation, and the plan digest. No I/O.
 *
 * @since 0.1.0
 * @category constructors
 */
export const compile = (options: {
  readonly planId: string
  readonly flow: string
  readonly nodes: ReadonlyArray<NodeDraft>
}): Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const keyed = yield* keyNodes(options.nodes, [], 0)
    const nodes = yield* annotate(keyed, new Set())
    const digest = yield* digestOf(options.planId, options.flow, nodes)
    return { planId: options.planId, flow: options.flow, generation: 0, baseDigest: digest, digest, nodes }
  })

/**
 * Appends an elaborated subgraph to an existing plan.
 *
 * The plan GROWS; it is never invalidated (`docs/specs/Specs/Plan.md`). Nodes
 * already in it keep their id, key, edges, and generation byte for byte — the
 * new nodes arrive pre-keyed against them, so a `hit` shows instantly.
 * Re-ordering after a reconciliation happens by re-keying *future* steps,
 * never by rewriting history.
 *
 * @since 0.1.0
 * @category constructors
 */
export const append = (
  plan: Plan,
  drafts: ReadonlyArray<NodeDraft>
): Effect.Effect<Plan, PlanError | StepKey.KeyMaterialError | Schema.SchemaError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const generation = plan.generation + 1
    const keyed = yield* keyNodes(drafts, plan.nodes, generation)
    const nodes = yield* annotate([...plan.nodes, ...keyed], new Set(plan.nodes.map((node) => node.id)))
    const digest = yield* digestOf(plan.planId, plan.flow, nodes)
    return { ...plan, generation, digest, nodes }
  })

/**
 * The nodes added by the newest generation — what {@link module:PlanStore}
 * appends and what the `subgraph-appended` journal record names.
 *
 * @since 0.1.0
 * @category accessors
 */
export const generationNodes = (plan: Plan): ReadonlyArray<PlanNode> =>
  plan.nodes.filter((node) => node.generation === plan.generation)
