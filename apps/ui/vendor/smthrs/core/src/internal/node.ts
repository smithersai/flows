/**
 * Internal AST and runtime representation for pipeable flow nodes.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Schema Shaped Builder.md` and
 * `docs/specs/Concepts/Build Phases.md`.
 *
 * @since 0.0.0
 */
import type * as Context from "effect/Context"
import { identity } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import { pipeArguments } from "effect/Pipeable"
import type * as Types from "effect/Types"
import type * as Effects from "../Effects.ts"

/** @internal */
export const TypeId = "~flows/core/Node" as const

/** @internal */
export type TypeId = typeof TypeId

/** @internal */
export interface Succeed {
  readonly _tag: "Succeed"
  readonly value: unknown
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface All {
  readonly _tag: "All"
  readonly nodes: Readonly<Record<string, NodeAst>>
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface Dynamic {
  readonly _tag: "Dynamic"
  readonly model?: string | undefined
  readonly flows: ReadonlyArray<unknown>
  readonly output?: unknown
  readonly prompt?: string | undefined
  readonly effects?: Effects.Declaration | undefined
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface AndThen {
  readonly _tag: "AndThen"
  readonly first: NodeAst
  readonly continuation: FunctionIdentity
  readonly next?: NodeAst | undefined
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface Map {
  readonly _tag: "Map"
  readonly first: NodeAst
  readonly mapper: FunctionIdentity
  readonly annotations: Context.Context<never>
}

/** @internal */
export interface FunctionIdentity {
  readonly _tag: "FunctionIdentity"
  readonly algorithm: "fnv1a32-source/v1"
  readonly digest: string
}

/** @internal */
export interface FlowCall {
  readonly _tag: "FlowCall"
  readonly target: unknown
  readonly input: unknown
  readonly annotations: Context.Context<never>
}

/** @internal */
export type NodeAst = Succeed | All | Dynamic | AndThen | Map | FlowCall

type Operation = (value: unknown) => unknown

const operations = new WeakMap<AndThen | Map, Operation>()
const flows = new WeakMap<FlowCall, unknown>()

/** @internal */
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

/** @internal */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: NodeAst
}

/** @internal */
export const NodeProto = {
  [TypeId]: {
    _A: identity,
    _E: identity
  },
  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments)
  }
}

/** @internal */
export const makeNode = <A = unknown, E = never>(ast: NodeAst): Node<A, E> =>
  Object.assign(Object.create(NodeProto), { ast })

/** @internal */
export const succeed = (value: unknown, annotations: Context.Context<never>): Succeed => ({
  _tag: "Succeed",
  value,
  annotations
})

/** @internal */
export const all = (
  nodes: Readonly<Record<string, NodeAst>>,
  annotations: Context.Context<never>
): All => ({
  _tag: "All",
  nodes,
  annotations
})

/** @internal */
export const dynamic = (
  options: Omit<Dynamic, "_tag" | "annotations">,
  annotations: Context.Context<never>
): Dynamic => ({
  _tag: "Dynamic",
  ...options,
  annotations
})

/** @internal */
export const andThen = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  annotations: Context.Context<never>
): AndThen => {
  const ast: AndThen = {
    _tag: "AndThen",
    first,
    continuation: functionIdentity(identitySource),
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/** @internal */
export const andThenNode = (
  first: NodeAst,
  next: NodeAst,
  annotations: Context.Context<never>
): AndThen => ({
  _tag: "AndThen",
  first,
  continuation: {
    _tag: "FunctionIdentity",
    algorithm: "fnv1a32-source/v1",
    digest: "static-node"
  },
  next,
  annotations
})

/** @internal */
export const map = (
  first: NodeAst,
  operation: Operation,
  identitySource: unknown,
  annotations: Context.Context<never>
): Map => {
  const ast: Map = {
    _tag: "Map",
    first,
    mapper: functionIdentity(identitySource),
    annotations
  }
  operations.set(ast, operation)
  return ast
}

/** @internal */
export const operation = (ast: AndThen | Map): Operation | undefined => operations.get(ast)

/** @internal */
export const flowCall = (
  flow: unknown,
  target: unknown,
  input: unknown,
  annotations: Context.Context<never>
): FlowCall => {
  const ast: FlowCall = {
    _tag: "FlowCall",
    target,
    input,
    annotations
  }
  flows.set(ast, flow)
  return ast
}

/** @internal */
export const flow = (ast: FlowCall): unknown => flows.get(ast)

/** @internal */
export const withAnnotations = (
  ast: NodeAst,
  annotations: Context.Context<never>
): NodeAst => {
  const annotated = {
    ...ast,
    annotations
  }
  if (ast._tag === "AndThen" || ast._tag === "Map") {
    const deferred = operations.get(ast)
    if (deferred !== undefined) operations.set(annotated as AndThen | Map, deferred)
  }
  if (ast._tag === "FlowCall") {
    const target = flows.get(ast)
    if (target !== undefined) flows.set(annotated as FlowCall, target)
  }
  return annotated
}
