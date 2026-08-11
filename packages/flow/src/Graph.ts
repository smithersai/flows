/**
 * Graph building: a flow declaration plus a real payload, walked once into the
 * drafts a plan is compiled from.
 *
 * This is the plan phase of `docs/specs/Concepts/Build Phases.md` and nothing
 * else — no I/O, no execution, no elaboration. {@link build} evaluates the
 * body with the REAL payload, because a body's own payload is data
 * (`docs/specs/Concepts/Unified Flow Authoring.md`), and evaluates every
 * continuation and branch arm exactly once against a STRICT
 * {@link module:Planned.Planned} placeholder, because a step result does not
 * exist yet. A body that computes on a placeholder therefore fails here,
 * naming the node, rather than baking `NaN` into a plan.
 *
 * Fatal refusals stay fatal. Computing on a planned value throws its
 * `GraphBuildError` immediately, as does recursively expanding an inline
 * `.call()`, because either case makes the requested graph invalid. Recoverable
 * topology loss, such as a missing or invalid continuation, is reported in
 * {@link Graph.diagnostics} so the remaining graph can still be inspected.
 *
 * Composition follows the same note: `Other.call(payload)` splices the
 * callee's body into this graph with the capabilities of the two declarations
 * intersected, and a flow that calls itself inline throws with the trampoline
 * (`docs/specs/Concepts/Trampoline Loops.md`) and the child boundary as the two
 * ways out. A branch expands BOTH arms, so the
 * exit condition and the handoff site are visible topology before anything
 * runs, and the predicate rides the branch's key material as a digest.
 *
 * What comes out is `@smthrs/plan` shaped: {@link Graph.drafts} feeds
 * `Plan.compile` and `Plan.append` unchanged, and the `Ref`/`Pending` inputs a
 * node's key material names are what the compiler turns into dependency
 * digests and the plan turns into edges. Structural node ids are lookup
 * addresses only and never enter a hashed value, so renaming a node re-keys
 * nothing and editing a mapper re-keys exactly what reads it.
 *
 * Adapted from the agent repo's `@smthrs/core` `Graph.ts`. The lenient
 * placeholder, the model-shaped `Dynamic` node, the lane-merge elaboration,
 * and the conflict pass do not come across: the placeholder is strict here,
 * a model call is an ordinary activity, and write overlap is resolved by
 * `Plan.compile`, which owns that verdict.
 *
 * @since 0.1.0
 */
import { GraphBuildError } from "@smthrs/plan/GraphBuildError"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Node from "@smthrs/plan/Node"
import type * as Plan from "@smthrs/plan/Plan"
import * as Planned from "@smthrs/plan/Planned"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Activity from "./Activity/Activity.ts"
import { TypeId as ActivityTypeId } from "./Activity/TypeId.ts"
import * as Annotations from "./Flow/Annotations.ts"
import type * as Flow from "./Flow/Flow.ts"
import { TypeId as FlowTypeId } from "./Flow/TypeId.ts"

/**
 * Why one node depends on another: `value` consumes a result, `continuation`
 * is the sequencing edge a builder or a branch arm records against the
 * upstream node it was evaluated with.
 *
 * @since 0.1.0
 * @category models
 */
export type EdgeReason = "value" | "continuation"

/**
 * A dependency edge, pointing from the node that produces to the node that
 * consumes.
 *
 * @since 0.1.0
 * @category models
 */
export interface Edge {
  readonly from: string
  readonly to: string
  readonly reason: EdgeReason
}

/**
 * One observed node: its structural address, the AST variant it came from, and
 * the {@link module:Plan.NodeDraft} the plan is compiled from.
 *
 * `kind` is the authoring variant, not the plan's node kind — every draft a
 * graph produces is a plan `step`.
 *
 * @since 0.1.0
 * @category models
 */
export interface GraphNode {
  readonly id: string
  readonly kind: Node.Ast["_tag"]
  readonly dependencies: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly placement: unknown
  readonly draft: Plan.NodeDraft
}

/**
 * What a pure per-node layer resolver is told. It is the identity of the
 * implementation a node would run against — hosts, services, permission
 * implementations — never a layer value or a runtime handle.
 *
 * @since 0.1.0
 * @category models
 */
export interface LayerRequest {
  readonly nodeId: string
  readonly kind: Node.Ast["_tag"]
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Annotations.Effects | undefined
  readonly placement: unknown
}

/**
 * The knobs {@link build} takes. `resolveLayers` is invoked once per node and
 * must be pure: planning performs no I/O, and a resolver that read the world
 * would make a plan a function of more than its declarations.
 *
 * @since 0.1.0
 * @category models
 */
export interface BuildOptions {
  readonly resolveLayers?: ((request: LayerRequest) => Iterable<string>) | undefined
  /**
   * The address the entry node is recorded under, `root` by default. A plan
   * grows by appending, and `Plan.append` refuses an id it already holds, so an
   * elaboration built for an existing plan names its own root.
   */
  readonly root?: string | undefined
}

/**
 * A built graph: the nodes in dependency order, the edges between them, and the
 * refusals that were recoverable enough to report rather than throw.
 *
 * DECIDED (2026-08-11, pending review): the drafts are NOT a field here. They
 * are derived from `nodes`, and the derivation carries a refusal — a graph with
 * diagnostics is inspectable but not compilable — so {@link drafts} is the only
 * way to ask for them. A field beside the accessor was a second, silent answer
 * to the same question: reading `graph.drafts` handed back the truncated drafts
 * of an incomplete graph while `Graph.drafts(graph)` threw on it. Effect keeps
 * data interfaces plain and puts the policy in the accessor, so the field goes
 * rather than growing a getter that throws from inside a `readonly` record.
 *
 * @since 0.1.0
 * @category models
 */
export interface Graph {
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<Edge>
  readonly diagnostics: ReadonlyArray<GraphBuildError>
}

/**
 * The declared-activity fields graph building reads. Only `Activity.make`'s
 * declared form produces an `ActivityCall`, so a call node's declaration is
 * one of these whenever the side table still holds it.
 *
 * @private
 */
interface ActivityDeclaration {
  readonly name: string
  readonly payloadSchema: Schema.Top
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly tier: Activity.Tier
  readonly annotations: Context.Context<never>
}

/**
 * The inert record `Node`'s AST keeps where a planned placeholder was.
 *
 * @private
 */
interface PlannedRecord {
  readonly node: string
  readonly path: ReadonlyArray<string>
}

/**
 * What a node that declared nothing contributes: it claims no path either way.
 *
 * @private
 */
// OPEN QUESTION (2026-08-11): the boundary mode a node with no declared effects defaults to
const emptyEffects: Plan.NodeEffects = { reads: [], writes: [], boundaryMode: "expected" }

/** @private */
const sorted = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort()

/** @private */
const flowDeclaration = (value: unknown): Flow.Any | undefined =>
  Predicate.hasProperty(value, FlowTypeId) ? value as unknown as Flow.Any : undefined

/** @private */
const activityDeclaration = (value: unknown): ActivityDeclaration | undefined =>
  Predicate.hasProperty(value, ActivityTypeId) ? value as unknown as ActivityDeclaration : undefined

/** @private */
const declaredEffects = (annotations: Context.Context<never>): Annotations.Effects | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, Annotations.EffectsDeclaration))

/** @private */
const declaredPlacement = (annotations: Context.Context<never>): unknown =>
  Option.getOrUndefined(Context.getOption(annotations, Annotations.Placement))

/**
 * The declaration identity that enters a call node's hashed body: what the
 * callee accepts and produces, so a schema change re-keys the call.
 *
 * @private
 */
const schemaIdentity = (schema: Schema.Top): unknown => Schema.toJsonSchemaDocument(schema)

/** @private */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/**
 * The reference a value stands for, whether it is a live placeholder — a real
 * payload may carry one, naming a node an earlier generation already planned —
 * or the inert record an AST payload kept.
 *
 * @private
 */
const referenceOf = (value: unknown): PlannedRecord | undefined => {
  const live = Planned.reference(value)
  if (live !== undefined) return live
  return Predicate.hasProperty(value, "_tag") && value._tag === "PlannedReference"
    ? value as unknown as PlannedRecord
    : undefined
}

/**
 * Rebuilds the strict placeholder a reference names, so a spliced body sees
 * the same refusals an inline body does.
 *
 * @private
 */
const placeholder = (reference: PlannedRecord, node: string): unknown =>
  reference.path.reduce<unknown>(
    (value, key) => (value as Record<string, unknown>)[key],
    Planned.make<unknown>(node)
  )

/**
 * Rebuilds a plain object under a mapped value per key, keeping every own key
 * as data.
 *
 * `output[key] = …` on an object literal is not a copy for one key: `__proto__`
 * routes through `Object.prototype`'s accessor, so an own `__proto__` field
 * whose value is a primitive is silently DROPPED and one whose value is an
 * object reparents the clone instead of being recorded on it. A payload may
 * carry that key — `JSON.parse` produces it as an own data property — and both
 * outcomes are wrong here: a hydrated payload would be planned and run with a
 * field its author wrote missing, and two payloads that differ only in that
 * field would hash to one key. `@smthrs/plan`'s AST cloner answers this with a
 * null-prototype target and `defineProperty`, and this is the same answer.
 *
 * @private
 */
const rebuild = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
  map: (member: unknown) => unknown
): Record<string, unknown> => {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: map(value[key]),
      writable: true
    })
  }
  return output
}

/**
 * Turns an AST payload back into what a body must see: real data where the
 * caller wrote data, strict placeholders where it passed a step result. The
 * substitution rewrites {@link module:Node.branchSubject} to the branch's own
 * upstream node, which is the arm's subject by construction.
 *
 * @private
 */
const hydrate = (value: unknown, substitutions: ReadonlyMap<string, string>): unknown => {
  const reference = referenceOf(value)
  if (reference !== undefined) return placeholder(reference, substitutions.get(reference.node) ?? reference.node)
  if (Array.isArray(value)) return value.map((item) => hydrate(item, substitutions))
  if (!isPlainObject(value)) return value
  return rebuild(value, Object.keys(value), (member) => hydrate(member, substitutions))
}

/**
 * The hashed form of a payload: placeholders keep their property path and drop
 * the node they came from, because the node id is a lookup address and the
 * dependency itself is named by a separate `Ref`. Values that are not plain
 * data pass through to the key canonicalizer, which is the one component
 * entitled to refuse them.
 *
 * @private
 */
const literal = (value: unknown): unknown => {
  const reference = Planned.reference(value)
  if (reference !== undefined) return { _tag: "PlannedInput", path: [...reference.path] }
  if (Array.isArray(value)) return value.map((item) => literal(item))
  if (!isPlainObject(value)) return value
  return rebuild(value, Object.keys(value).sort(), literal)
}

/**
 * Collects the upstream results a payload consumes, in declaration order and
 * without duplicates.
 *
 * @private
 */
const references = (value: unknown, into: Array<PlannedRecord>): void => {
  const reference = Planned.reference(value)
  if (reference !== undefined) {
    into.push(reference)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) references(item, into)
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value).sort()) references(value[key], into)
}

/**
 * The `Literal` a payload hashes as, followed by one `Ref` per distinct
 * upstream result it reads.
 *
 * @private
 */
const payloadInputs = (payload: unknown): ReadonlyArray<KeyMaterial.InputRef> => {
  const found: Array<PlannedRecord> = []
  references(payload, found)
  const inputs: Array<KeyMaterial.InputRef> = [{ _tag: "Literal", value: literal(payload) }]
  const seen = new Set<string>()
  for (const reference of found) {
    const identity = JSON.stringify([reference.node, ...reference.path])
    if (seen.has(identity)) continue
    seen.add(identity)
    inputs.push({ _tag: "Ref", from: reference.node, path: [...reference.path] })
  }
  return inputs
}

/**
 * What one visit needs to know: where it is, what it may do, which node the
 * enclosing branch's subject stands for, which flows are already being
 * spliced, and the upstream node it continues from.
 *
 * @private
 */
interface Visit {
  readonly ast: Node.Ast
  readonly id: string
  readonly capabilities: ReadonlyArray<string>
  readonly substitutions: ReadonlyMap<string, string>
  readonly stack: ReadonlyArray<Flow.Any>
  readonly prerequisite: string | undefined
}

/**
 * Builds the graph of a flow declaration, or of a bare node, by walking the
 * AST once.
 *
 * A flow is entered as a call to itself: the returned graph's `root` node is
 * that call, carrying the flow's declared effects, placement, and
 * capabilities, and its body — when it has one — is spliced beneath it. A flow
 * with no body is therefore a leaf, exactly like a body-less callee, rather
 * than a special case.
 *
 * @since 0.1.0
 * @category constructors
 */
export const build = (
  flowOrNode: Flow.Any | Node.Any,
  payload?: unknown,
  options: BuildOptions = {}
): Graph => {
  const observed: Array<GraphNode> = []
  const observedEdges: Array<Edge> = []
  const observedDiagnostics: Array<GraphBuildError> = []

  const record = (entry: {
    readonly id: string
    readonly kind: Node.Ast["_tag"]
    readonly dependencies: ReadonlyArray<string>
    readonly capabilities: ReadonlyArray<string>
    readonly effects: Annotations.Effects | undefined
    readonly placement: unknown
    readonly tier: KeyMaterial.KeyMaterial["kind"]
    readonly body: unknown
    readonly inputs: ReadonlyArray<KeyMaterial.InputRef>
  }): string => {
    const material: KeyMaterial.KeyMaterial = {
      version: KeyMaterial.version,
      kind: entry.tier,
      body: entry.body,
      inputs: entry.inputs,
      layers: sorted(
        options.resolveLayers?.({
          nodeId: entry.id,
          kind: entry.kind,
          capabilities: entry.capabilities,
          effects: entry.effects,
          placement: entry.placement
        }) ?? []
      ),
      capabilities: entry.capabilities,
      ...(entry.effects === undefined ? {} : { effects: entry.effects }),
      ...(entry.placement === undefined ? {} : { placement: entry.placement })
    }
    observed.push({
      id: entry.id,
      kind: entry.kind,
      dependencies: entry.dependencies,
      capabilities: entry.capabilities,
      placement: entry.placement,
      draft: { id: entry.id, material, effects: entry.effects ?? emptyEffects }
    })
    return entry.id
  }

  /**
   * The node a flow call becomes, shared by the entry point and by every
   * `FlowCall` in a body.
   */
  const flowNode = (call: {
    readonly id: string
    readonly flow: string
    readonly mode: "inline" | "boundary"
    readonly declaration: Flow.Any | undefined
    readonly payload: unknown
    readonly capabilities: ReadonlyArray<string>
    readonly substitutions: ReadonlyMap<string, string>
    readonly stack: ReadonlyArray<Flow.Any>
    readonly dependencies: Array<string>
    readonly inputs: ReadonlyArray<KeyMaterial.InputRef>
  }): string => {
    const annotations = call.declaration?.annotations ?? Context.empty()
    const dependencies = call.dependencies
    const inputs: Array<KeyMaterial.InputRef> = [...payloadInputs(call.payload), ...call.inputs]
    const target = call.mode === "inline" ? call.declaration : undefined
    const body = target?.body
    const ceiling = sorted(Context.get(annotations, Annotations.Capabilities))
    if (target !== undefined && body !== undefined) {
      if (call.stack.includes(target)) {
        throw new GraphBuildError({
          code: "recursion_requires_boundary",
          node: call.id,
          path: [],
          message: `Flow "${call.flow}" calls itself inline at "${call.id}". ` +
            `Use ${call.flow}.to(payload) to hand off to the next round, or .child(payload) for an explicit boundary.`
        })
      } else {
        const built = body(call.payload)
        const spliced = visit({
          ast: built.ast,
          id: `${call.id}.flow`,
          capabilities: ceiling.filter((capability) => call.capabilities.includes(capability)),
          substitutions: call.substitutions,
          stack: [...call.stack, target],
          prerequisite: undefined
        })
        dependencies.push(spliced)
        observedEdges.push({ from: spliced, to: call.id, reason: "value" })
        inputs.push({ _tag: "Ref", from: spliced, path: [] })
      }
    }
    return record({
      id: call.id,
      kind: "FlowCall",
      dependencies,
      capabilities: call.capabilities,
      effects: declaredEffects(annotations),
      placement: declaredPlacement(annotations),
      tier: "sealed",
      body: {
        _tag: "FlowCall",
        flow: call.flow,
        mode: call.mode,
        declaration: call.declaration === undefined ? undefined : {
          payload: schemaIdentity(call.declaration.payloadSchema),
          success: schemaIdentity(call.declaration.successSchema),
          error: schemaIdentity(call.declaration.errorSchema),
          capabilities: ceiling,
          // A spliced body re-keys this call through the `Ref` on the node it
          // produced. A call the graph keeps as a LEAF — an explicit boundary,
          // a callee whose body is refused — has no such node, and its own
          // digest is the only thing an edited body can move.
          body: call.declaration.body === undefined ? undefined : Node.functionIdentity(call.declaration.body)
        }
      },
      inputs
    })
  }

  /**
   * The continuation of an `AndThen`, evaluated exactly once against the
   * placeholder standing for its upstream result. A continuation that is gone
   * — an AST that crossed a serialization boundary — or that answered with
   * something other than a node leaves the remainder out and says so, because
   * a graph missing that recoverable step is still worth inspecting. Computing
   * on the placeholder is a fatal build refusal and propagates unchanged.
   */
  const continuation = (
    ast: Extract<Node.Ast, { readonly _tag: "AndThen" }>,
    id: string,
    subject: string
  ): Node.Ast | undefined => {
    const builder = Node.continuation(ast)
    if (builder === undefined) {
      observedDiagnostics.push(
        new GraphBuildError({
          code: "invalid_continuation",
          node: id,
          path: [],
          message: `Node.andThen at "${id}" no longer holds its continuation builder, so its continuation is ` +
            "missing from the graph. An AST that crossed a serialization boundary left that side table behind."
        })
      )
      return undefined
    }
    const built = builder(Planned.make<unknown>(subject))
    if (Node.isNode(built)) return built.ast
    observedDiagnostics.push(
      new GraphBuildError({
        code: "invalid_continuation",
        node: id,
        path: [],
        message: `Node.andThen at "${id}" did not produce a Node, so its continuation is missing from the graph.`
      })
    )
    return undefined
  }

  const visit = (request: Visit): string => {
    const { ast, capabilities, id, stack, substitutions } = request
    const dependencies: Array<string> = []
    const inputs: Array<KeyMaterial.InputRef> = []
    const depend = (from: string, reason: EdgeReason): void => {
      dependencies.push(from)
      observedEdges.push({ from, to: id, reason })
      inputs.push(reason === "continuation" ? { _tag: "Pending", from } : { _tag: "Ref", from, path: [] })
    }
    const child = (childAst: Node.Ast, childId: string, options: {
      readonly substitutions?: ReadonlyMap<string, string>
      readonly prerequisite?: string | undefined
    } = {}): string =>
      visit({
        ast: childAst,
        id: childId,
        capabilities,
        substitutions: options.substitutions ?? substitutions,
        stack,
        prerequisite: options.prerequisite
      })

    if (request.prerequisite !== undefined) depend(request.prerequisite, "continuation")

    switch (ast._tag) {
      case "FlowCall": {
        return flowNode({
          id,
          flow: ast.flow,
          mode: ast.mode,
          declaration: flowDeclaration(Node.declaration(ast)),
          payload: hydrate(ast.payload, substitutions),
          capabilities,
          substitutions,
          stack,
          dependencies,
          inputs
        })
      }
      case "ActivityCall": {
        const declared = activityDeclaration(Node.declaration(ast))
        const annotations = declared?.annotations ?? Context.empty()
        return record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: declaredEffects(annotations),
          placement: declaredPlacement(annotations),
          tier: declared?.tier ?? "sealed",
          body: {
            _tag: "ActivityCall",
            activity: ast.activity,
            tier: declared?.tier ?? "sealed",
            declaration: declared === undefined ? undefined : {
              payload: schemaIdentity(declared.payloadSchema),
              success: schemaIdentity(declared.successSchema),
              error: schemaIdentity(declared.errorSchema)
            }
          },
          inputs: [...payloadInputs(hydrate(ast.payload, substitutions)), ...inputs]
        })
      }
      case "Succeed": {
        return record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          tier: "sealed",
          body: { _tag: ast._tag },
          inputs: [...payloadInputs(hydrate(ast.value, substitutions)), ...inputs]
        })
      }
      case "All": {
        const members = Object.keys(ast.nodes)
        for (const member of members) depend(child(ast.nodes[member]!, `${id}.all.${member}`), "value")
        return record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          tier: "sealed",
          body: { _tag: ast._tag, members },
          inputs
        })
      }
      case "Map": {
        depend(child(ast.first, `${id}.map`), "value")
        return record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          tier: "sealed",
          body: { _tag: ast._tag, mapper: ast.mapper },
          inputs
        })
      }
      case "AndThen": {
        const first = child(ast.first, `${id}.andThen`)
        depend(first, "value")
        const next = ast.next ?? continuation(ast, id, first)
        if (next !== undefined) depend(child(next, `${id}.then`, { prerequisite: first }), "value")
        return record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          tier: "sealed",
          body: { _tag: ast._tag, continuation: ast.continuation, static: ast.next !== undefined },
          inputs
        })
      }
      case "Branch": {
        const first = child(ast.first, `${id}.branch`)
        depend(first, "value")
        // OPEN QUESTION (2026-08-11): every arm subject is recorded under the one
        // `Node.branchSubject` name, so an arm nested inside another branch's
        // arm cannot say which subject it meant. The innermost binding wins
        // here; whether the AST should carry per-branch subject names instead
        // is undecided.
        const arms = new Map([...substitutions, [Node.branchSubject, first]])
        depend(child(ast.then, `${id}.then`, { substitutions: arms, prerequisite: first }), "value")
        depend(child(ast.else, `${id}.else`, { substitutions: arms, prerequisite: first }), "value")
        return record({
          id,
          kind: ast._tag,
          dependencies,
          capabilities,
          effects: undefined,
          placement: undefined,
          tier: "sealed",
          body: { _tag: ast._tag, predicate: ast.predicate },
          inputs
        })
      }
    }
  }

  const declaration = flowDeclaration(flowOrNode)
  const root = options.root ?? "root"
  if (declaration === undefined) {
    visit({
      ast: (flowOrNode as Node.Any).ast,
      id: root,
      capabilities: [],
      substitutions: new Map(),
      stack: [],
      prerequisite: undefined
    })
  } else {
    flowNode({
      id: root,
      flow: declaration._tag,
      mode: "inline",
      declaration,
      payload: hydrate(payload, new Map()),
      capabilities: sorted(Context.get(declaration.annotations, Annotations.Capabilities)),
      substitutions: new Map(),
      stack: [],
      dependencies: [],
      inputs: []
    })
  }

  return {
    nodes: observed,
    edges: observedEdges,
    diagnostics: observedDiagnostics
  }
}

/**
 * The observed nodes, children before the parents that consume them.
 *
 * @since 0.1.0
 * @category accessors
 */
export const nodes = (graph: Graph): ReadonlyArray<GraphNode> => graph.nodes

/**
 * The dependency edges, in the order they were observed.
 *
 * @since 0.1.0
 * @category accessors
 */
export const edges = (graph: Graph): ReadonlyArray<Edge> => graph.edges

/**
 * The drafts, in node order, ready for `Plan.compile` or `Plan.append`
 * unchanged.
 *
 * A graph with diagnostics is inspectable but intentionally not compilable:
 * returning its partial drafts would turn missing topology into a valid plan.
 * This accessor therefore throws the first typed build refusal, and it is the
 * ONLY way to reach the drafts — the built graph holds nodes, and a draft is
 * the node's own {@link GraphNode.draft}.
 *
 * @since 0.1.0
 * @category accessors
 */
export const drafts = (graph: Graph): ReadonlyArray<Plan.NodeDraft> => {
  const refusal = graph.diagnostics[0]
  if (refusal !== undefined) throw refusal
  return graph.nodes.map((node) => node.draft)
}

/**
 * Recoverable topology issues recorded during the build, such as a missing
 * continuation builder or a continuation that did not produce a node. Fatal
 * refusals, including computing on a planned value and recursive inline
 * `.call()`, throw from {@link build} and never appear here.
 *
 * @since 0.1.0
 * @category accessors
 */
export const diagnostics = (graph: Graph): ReadonlyArray<GraphBuildError> => graph.diagnostics
