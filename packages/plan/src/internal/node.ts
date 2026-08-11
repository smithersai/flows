/**
 * The node AST, and the side tables the functions hang off.
 *
 * Two invariants shape every declaration here, both from
 * `docs/specs/Concepts/Unified Flow Authoring.md`. The AST is **closure-free
 * and JSON serializable**, so a plan can be shipped, stored, diffed, and
 * rendered without the process that built it; and control flow is
 * **structure**, so a branch stores both arms as ASTs rather than a function
 * that would have to be run to find out what comes next.
 *
 * The functions an author does write — a mapper, a continuation, a branch
 * predicate — live in `WeakMap`s keyed by the AST node they belong to, and the
 * AST keeps only a {@link FunctionIdentity} digest of their source. The digest
 * is what enters content identity (`docs/specs/Concepts/Step Keys.md`); the
 * `WeakMap` is what the run reaches for when it has the real value in hand, and
 * it drops with the AST it is keyed by.
 *
 * Adapted from the agent repo's `@smthrs/core` `internal/node.ts`. `Dynamic`
 * does not come across — a model call is an ordinary activity here — and
 * neither do annotations, which are `Context` values and would break
 * serializability.
 *
 * @since 0.1.0
 */
import { identity } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as Types from "effect/Types"
import * as Planned from "../Planned.ts"

/**
 * The runtime type identifier every node carries.
 *
 * @since 0.1.0
 * @private
 */
export const TypeId = "~flows/plan/Node" as const

/**
 * The type-level form of {@link TypeId}.
 *
 * @since 0.1.0
 * @private
 */
export type TypeId = typeof TypeId

/**
 * A constant, known before anything runs.
 *
 * @since 0.1.0
 * @private
 */
export interface Succeed {
  readonly _tag: "Succeed"
  readonly value: unknown
}

/**
 * Independent children, combined by name. Width is fixed here, at plan time:
 * there is no dynamic fan-out.
 *
 * @since 0.1.0
 * @private
 */
export interface All {
  readonly _tag: "All"
  readonly nodes: Readonly<Record<string, NodeAst>>
}

/**
 * A deferred pure transformation of an upstream result. `map` transforms; it
 * never decides.
 *
 * @since 0.1.0
 * @private
 */
export interface Map {
  readonly _tag: "Map"
  readonly first: NodeAst
  readonly mapper: FunctionIdentity
}

/**
 * A continuation after an upstream node. `next` is present when the author
 * supplied a node directly instead of a builder, in which case the topology is
 * already known and nothing has to be evaluated to reveal it.
 *
 * @since 0.1.0
 * @private
 */
export interface AndThen {
  readonly _tag: "AndThen"
  readonly first: NodeAst
  readonly continuation: FunctionIdentity
  readonly next?: NodeAst | undefined
}

/**
 * A decision whose arms are static topology. The predicate runs at run time on
 * the real value; both arms are already ASTs, so the exit condition and the
 * handoff site are visible before anything runs
 * (`docs/specs/Concepts/Trampoline Loops.md`).
 *
 * @since 0.1.0
 * @private
 */
export interface Branch {
  readonly _tag: "Branch"
  readonly first: NodeAst
  readonly predicate: FunctionIdentity
  readonly then: NodeAst
  readonly else: NodeAst
}

/**
 * How a flow call joins the caller's plan: `inline` splices the callee's body
 * in, `boundary` makes it one node with its own execution.
 *
 * @since 0.1.0
 * @private
 */
export type CallMode = "inline" | "boundary"

/**
 * A call to another flow. The AST keeps the callee's tag and the payload;
 * the declaration itself is in the side table, because a flow value carries
 * schemas and a body and is not JSON.
 *
 * @since 0.1.0
 * @private
 */
export interface FlowCall {
  readonly _tag: "FlowCall"
  readonly flow: string
  readonly mode: CallMode
  readonly payload: unknown
}

/**
 * A call to an activity: the atom that does work. Same split as
 * {@link FlowCall}, and no mode — an activity is always one node.
 *
 * @since 0.1.0
 * @private
 */
export interface ActivityCall {
  readonly _tag: "ActivityCall"
  readonly activity: string
  readonly payload: unknown
}

/**
 * The serializable stand-in for a function: a tagged digest of its normalized
 * source. The algorithm tag is versioned so a change to how sources are
 * digested re-keys everything derived from one, rather than colliding with it.
 *
 * @since 0.1.0
 * @private
 */
export interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "fnv1a32-source/v1"
  readonly digest: string
}

/**
 * The serializable form of a planned value embedded in an AST value or
 * payload. The strict proxy itself cannot enter the AST because serializing it
 * is deliberately a build error.
 *
 * @since 0.1.0
 * @private
 */
export interface PlannedReference {
  readonly _tag: "PlannedReference"
  readonly node: string
  readonly path: ReadonlyArray<string>
}

/**
 * Every AST variant.
 *
 * @since 0.1.0
 * @private
 */
export type NodeAst = Succeed | All | Map | AndThen | Branch | FlowCall | ActivityCall

type Operation = (value: unknown) => unknown

type Predicate = (value: unknown) => boolean

const operations = new WeakMap<AndThen | Map, Operation>()
const predicates = new WeakMap<Branch, Predicate>()
const declarations = new WeakMap<ActivityCall | FlowCall, unknown>()

/**
 * Replaces strict planned proxies with their inert reference records while
 * preserving the shape of JSON payloads.
 *
 * @since 0.1.0
 * @private
 */
export const value = (input: unknown, seen: WeakMap<object, unknown> = new WeakMap()): unknown => {
  const reference = Planned.reference(input)
  if (reference !== undefined) {
    return { _tag: "PlannedReference", node: reference.node, path: [...reference.path] } satisfies PlannedReference
  }
  if (input === null || typeof input !== "object") return input
  const previous = seen.get(input)
  if (previous !== undefined) return previous
  if (Array.isArray(input)) {
    const output: Array<unknown> = []
    seen.set(input, output)
    for (const item of input) output.push(value(item, seen))
    return output
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  seen.set(input, output)
  for (const key of Object.keys(input)) {
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: value(input[key as keyof typeof input], seen),
      writable: true
    })
  }
  return output
}

/**
 * Digests a function by its source: whitespace collapsed, then FNV-1a over the
 * UTF-16 code units. Two separately written functions with the same source
 * therefore key identically, and an edited one does not.
 *
 * @since 0.1.0
 * @private
 */
export const functionIdentity = (operation: unknown): FunctionIdentity => {
  const source = Function.prototype.toString.call(operation).replaceAll(/\s+/g, " ").trim()
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return {
    _tag: "FunctionIdentity",
    algorithm: "fnv1a32-source/v1",
    digest: (hash >>> 0).toString(16).padStart(8, "0")
  }
}

/**
 * The pipeable wrapper around an AST.
 *
 * @since 0.1.0
 * @private
 */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: NodeAst
}

/**
 * The prototype every node shares, so `pipe` is one function rather than one
 * closure per node.
 *
 * @since 0.1.0
 * @private
 */
export const NodeProto = {
  [TypeId]: {
    _A: identity,
    _E: identity
  },
  pipe() {
    // eslint-disable-next-line prefer-rest-params -- `pipeArguments` takes the arguments object itself.
    return pipeArguments(this, arguments)
  }
}

/**
 * Wraps an AST as a node.
 *
 * @since 0.1.0
 * @private
 */
export const makeNode = <A = unknown, E = never>(ast: NodeAst): Node<A, E> =>
  Object.assign(Object.create(NodeProto), { ast })

/**
 * Constructs a {@link Succeed}.
 *
 * @since 0.1.0
 * @private
 */
export const succeed = (input: unknown): Succeed => ({ _tag: "Succeed", value: value(input) })

/**
 * Constructs an {@link All}.
 *
 * @since 0.1.0
 * @private
 */
export const all = (nodes: Readonly<Record<string, NodeAst>>): All => ({ _tag: "All", nodes })

/**
 * Constructs a {@link Map}, filing the mapper under the AST it belongs to.
 *
 * @since 0.1.0
 * @private
 */
export const map = (first: NodeAst, operation: Operation, source: unknown): Map => {
  const ast: Map = { _tag: "Map", first, mapper: functionIdentity(source) }
  operations.set(ast, operation)
  return ast
}

/**
 * Constructs an {@link AndThen} from a builder. The builder is evaluated once
 * against a planned value when the graph is built, never here.
 *
 * @since 0.1.0
 * @private
 */
export const andThen = (first: NodeAst, operation: Operation, source: unknown): AndThen => {
  const ast: AndThen = { _tag: "AndThen", first, continuation: functionIdentity(source) }
  operations.set(ast, operation)
  return ast
}

/**
 * Constructs an {@link AndThen} from a node the author supplied directly. There
 * is no function to digest, so the continuation carries a fixed marker.
 *
 * @since 0.1.0
 * @private
 */
export const andThenNode = (first: NodeAst, next: NodeAst): AndThen => ({
  _tag: "AndThen",
  first,
  continuation: { _tag: "FunctionIdentity", algorithm: "fnv1a32-source/v1", digest: "static-node" },
  next
})

/**
 * Constructs a {@link Branch}. Both arms arrive already evaluated, because a
 * branch that had to be run to reveal its topology would not be a plan.
 *
 * @since 0.1.0
 * @private
 */
export const branch = (
  first: NodeAst,
  predicate: Predicate,
  source: unknown,
  then: NodeAst,
  otherwise: NodeAst
): Branch => {
  const ast: Branch = {
    _tag: "Branch",
    first,
    predicate: functionIdentity(source),
    then,
    else: otherwise
  }
  predicates.set(ast, predicate)
  return ast
}

/**
 * Constructs a {@link FlowCall}, filing the flow declaration beside it.
 *
 * @since 0.1.0
 * @private
 */
export const flowCall = (declaration: unknown, flow: string, mode: CallMode, payload: unknown): FlowCall => {
  const ast: FlowCall = { _tag: "FlowCall", flow, mode, payload: value(payload) }
  declarations.set(ast, declaration)
  return ast
}

/**
 * Constructs an {@link ActivityCall}, filing the activity declaration beside
 * it.
 *
 * @since 0.1.0
 * @private
 */
export const activityCall = (declaration: unknown, activity: string, payload: unknown): ActivityCall => {
  const ast: ActivityCall = { _tag: "ActivityCall", activity, payload: value(payload) }
  declarations.set(ast, declaration)
  return ast
}

/**
 * The deferred function of a map or a continuation.
 *
 * @since 0.1.0
 * @private
 */
export const operation = (ast: AndThen | Map): Operation | undefined => operations.get(ast)

/**
 * The run-time predicate of a branch.
 *
 * @since 0.1.0
 * @private
 */
export const predicate = (ast: Branch): Predicate | undefined => predicates.get(ast)

/**
 * The flow or activity declaration a call node names.
 *
 * @since 0.1.0
 * @private
 */
export const declaration = (ast: ActivityCall | FlowCall): unknown => declarations.get(ast)
