/**
 * Pure, pipeable nodes: the shape a flow body describes and nothing more.
 *
 * Building a node records an inspectable AST and executes nothing — the same
 * split as Bazel's `ctx.actions.run`, which declares an action rather than
 * running one (`docs/specs/Concepts/Unified Flow Authoring.md`). A plan is
 * always a DAG, so there is no loop node here and never will be: repetition
 * lives one level up, in what a flow settles with
 * (`docs/specs/Concepts/Trampoline Loops.md`).
 *
 * Control flow is structure. {@link branch} takes both arms and evaluates each
 * ONCE, symbolically, so the exit condition and the handoff site are visible
 * topology before anything runs; its predicate is digested and runs later on
 * the real value. {@link map} is transformation only. The rule the authoring
 * note states, and this module encodes: **map transforms; branch decides.**
 *
 * Adapted from the agent repo's `@smthrs/core` `Node.ts`. `Dynamic` is gone —
 * a model call is an ordinary activity, and nothing model-shaped belongs in
 * this package — and node annotations are gone with it, because the AST has to
 * stay JSON serializable.
 *
 * @since 0.1.0
 */
import { dual } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import type * as Types from "effect/Types"
import { GraphBuildError } from "./GraphBuildError.ts"
import * as internal from "./internal/node.ts"
import * as Planned from "./Planned.ts"

/**
 * The runtime type identifier carried by every node.
 *
 * @since 0.1.0
 * @category type ids
 */
export const TypeId: TypeId = internal.TypeId

/**
 * The type-level form of {@link TypeId}.
 *
 * @since 0.1.0
 * @category type ids
 */
export type TypeId = "~flows/plan/Node"

/**
 * The inspectable AST a node stores: closure-free, and JSON serializable for
 * every JSON payload an author puts in it.
 *
 * @since 0.1.0
 * @category models
 */
export type Ast = internal.NodeAst

/**
 * The serializable stand-in an AST keeps for a plan-time function: a digest of
 * its normalized source, hashed in place of a closure that could not be
 * shipped, stored, or compared.
 *
 * @since 0.1.0
 * @category models
 */
export type FunctionIdentity = Extract<Ast, { readonly _tag: "Map" }>["mapper"]

/**
 * A pure graph-building value, covariant in what it will succeed and fail
 * with. It is a description: holding one has run nothing.
 *
 * @since 0.1.0
 * @category models
 */
export interface Node<out A, out E = never> extends Pipeable.Pipeable {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
  }
  readonly ast: Ast
}

/**
 * Any node, whatever it succeeds or fails with.
 *
 * @since 0.1.0
 * @category models
 */
export type Any = Node<unknown, unknown>

/**
 * The success type of a node.
 *
 * @since 0.1.0
 * @category models
 */
export type Success<N> = N extends Node<infer A, infer _E> ? A : never

/**
 * The error type of a node.
 *
 * @since 0.1.0
 * @category models
 */
export type Error<N> = N extends Node<infer _A, infer E> ? E : never

/**
 * The node reference a branch arm's symbolic subject carries. Arms are built
 * before the graph assigns ids, so every reference an arm records names this
 * placeholder, and graph building rewrites it to the branch's own upstream
 * node — which is `first`, structurally, and therefore not a guess.
 *
 * @since 0.1.0
 * @category constants
 */
export const branchSubject = "branch/subject"

/** @private */
let branchOrdinal = 0

/**
 * The prefix of the node reference a catch failure arm's symbolic error
 * carries. Each {@link catch_} mints its own token under this prefix, so an
 * outer error captured inside a nested failure arm keeps naming the outer
 * catch, and graph building rewrites each token to the node that catch
 * protects.
 *
 * @since 0.1.0
 * @category constants
 */
export const catchSubject = "catch/subject"

/** @private */
let catchOrdinal = 0

/**
 * The two arms of a decision plus the predicate that chooses between them.
 *
 * `if` runs at RUN time on the real value. `then` and `else` run at PLAN time,
 * once each, against a {@link module:Planned.Planned} placeholder — they
 * describe topology, so they may pass the value on but never compute on it.
 *
 * @since 0.1.0
 * @category models
 */
export interface BranchOptions<A, B1, E1, B2, E2> {
  readonly if: (value: A) => boolean
  readonly then: (value: Planned.Planned<A>) => Node<B1, E1>
  readonly else: (value: Planned.Planned<A>) => Node<B2, E2>
}

/**
 * The statically planned recovery arm and optional schema selecting which
 * typed failures it handles.
 *
 * @since 0.1.0
 * @category models
 */
export interface CatchOptions<E, B, E2, Handled = E> {
  readonly error?: Schema.Schema<Handled> | undefined
  readonly onFailure: (error: Planned.Planned<Handled>) => Node<B, E2>
}

/**
 * Checks whether a value is a node.
 *
 * @since 0.1.0
 * @category guards
 */
export const isNode = (value: unknown): value is Any => Predicate.hasProperty(value, TypeId)

/**
 * A node that succeeds with a constant.
 *
 * @since 0.1.0
 * @category constructors
 */
export const succeed = <A>(value: A): Node<A> => internal.makeNode<A>(internal.succeed(value))

/**
 * Combines independent children into one node, keyed by name.
 *
 * Width is fixed here, at plan time. Fanning out over something a step
 * discovered is not this: end the round and carry the list in the next flow's
 * payload, where it is real data (`docs/specs/Concepts/Trampoline Loops.md`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const all = <const R extends Readonly<Record<string, Any>>>(
  nodes: R
): Node<
  Types.Simplify<{ readonly [K in keyof R]: Success<R[K]> }>,
  Error<R[keyof R]>
> => {
  const asts: Record<string, Ast> = Object.create(null) as Record<string, Ast>
  for (const [member, node] of Object.entries(nodes)) {
    if (!isNode(node)) {
      throw new GraphBuildError({
        code: "invalid_all_member",
        node: member,
        path: [],
        message: `Node.all expected a Node at member "${member}"`
      })
    }
    Object.defineProperty(asts, member, {
      configurable: true,
      enumerable: true,
      value: node.ast,
      writable: true
    })
  }
  return internal.makeNode(internal.all(asts))
}

/**
 * Transforms an eventual success value with a deferred pure function.
 *
 * The function is digested, not run: it executes later, on the real value.
 * This is where computation on a step result belongs — and only computation. A
 * `map` that decides what happens next is a `branch` written wrongly.
 *
 * @since 0.1.0
 * @category mapping
 */
export const map: {
  <A, B>(f: (a: A) => B): <E>(self: Node<A, E>) => Node<B, E>
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E>
} = dual(
  2,
  <A, E, B>(self: Node<A, E>, f: (a: A) => B): Node<B, E> =>
    internal.makeNode<B, E>(internal.map(self.ast, (value) => f(value as A), f))
)

/**
 * Sequences a builder, or a node, after this one.
 *
 * A node may be supplied directly when the first result is not needed. A
 * builder is evaluated once, against a placeholder, when the graph is built —
 * so the downstream topology and the references it consumes are known before
 * execution.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const andThen: {
  <A, B, E2>(f: (a: Planned.Planned<A>) => Node<B, E2>): <E>(self: Node<A, E>) => Node<B, E | E2>
  <B, E2>(next: Node<B, E2>): <A, E>(self: Node<A, E>) => Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, f: (a: Planned.Planned<A>) => Node<B, E2>): Node<B, E | E2>
  <A, E, B, E2>(self: Node<A, E>, next: Node<B, E2>): Node<B, E | E2>
} = dual(
  2,
  <A, E, B, E2>(
    self: Node<A, E>,
    next: Node<B, E2> | ((a: Planned.Planned<A>) => Node<B, E2>)
  ): Node<B, E | E2> => {
    if (typeof next !== "function" && !isNode(next)) {
      throw new GraphBuildError({
        code: "invalid_continuation",
        node: "andThen/next",
        path: [],
        message: "Node.andThen expected its direct continuation to be a Node"
      })
    }
    return internal.makeNode<B, E | E2>(
      typeof next === "function"
        ? internal.andThen(self.ast, (value) => next(value as Planned.Planned<A>), next)
        : internal.andThenNode(self.ast, next.ast)
    )
  }
)

/**
 * Builds one arm, once, against the symbolic subject.
 *
 * @private
 */
const arm = <A, B, E>(
  build: (value: Planned.Planned<A>) => Node<B, E>,
  subject: Planned.Planned<A>,
  side: string
): Ast => {
  const node = build(subject)
  if (!isNode(node)) {
    throw new GraphBuildError({
      code: "invalid_continuation",
      node: `${branchSubject}/${side}`,
      path: [],
      message: `Node.branch expected its "${side}" arm to return a Node`
    })
  }
  return node.ast
}

/**
 * Decides between two arms, both of them static topology.
 *
 * Each arm builder is evaluated exactly once, here, against a
 * {@link module:Planned.Planned} placeholder, and the resulting ASTs are what
 * the node stores — so a plan shows the exit condition and both continuations
 * before it runs. The predicate is digested and evaluated at run time on the
 * real value, which is why none of the plan-time placeholder machinery leaks
 * into control flow.
 *
 * @since 0.1.0
 * @category sequencing
 */
export const branch: {
  <A, B1, E1, B2, E2>(
    options: BranchOptions<A, B1, E1, B2, E2>
  ): <E>(self: Node<A, E>) => Node<B1 | B2, E | E1 | E2>
  <A, E, B1, E1, B2, E2>(
    self: Node<A, E>,
    options: BranchOptions<A, B1, E1, B2, E2>
  ): Node<B1 | B2, E | E1 | E2>
} = dual(
  2,
  <A, E, B1, E1, B2, E2>(
    self: Node<A, E>,
    options: BranchOptions<A, B1, E1, B2, E2>
  ): Node<B1 | B2, E | E1 | E2> => {
    const subjectToken = `${branchSubject}/${branchOrdinal++}`
    const subject = Planned.make<A>(subjectToken)
    return internal.makeNode<B1 | B2, E | E1 | E2>(
      internal.branch(
        subjectToken,
        self.ast,
        (value) => options.if(value as A),
        options.if,
        arm(options.then, subject, "then"),
        arm(options.else, subject, "else")
      )
    )
  }
)

/**
 * Recovers from matching typed failures with static failure topology.
 *
 * The protected graph and failure arm are both stored in the AST. The arm is
 * built once at plan time against a strict planned error placeholder. With no
 * schema the whole typed error channel is handled; a schema handles only the
 * values it accepts and preserves the remainder in the resulting error type.
 *
 * @since 0.1.0
 * @category sequencing
 */
const catch_: {
  <Handled, B, E2>(
    options: CatchOptions<unknown, B, E2, Handled> & {
      readonly error: Schema.Schema<Handled>
    }
  ): <A, E>(self: Node<A, E>) => Node<A | B, Exclude<E, Handled> | E2>
  <E, B, E2>(
    options: CatchOptions<E, B, E2> & {
      readonly error?: undefined
    }
  ): <A>(self: Node<A, E>) => Node<A | B, E2>
  <A, E, Handled, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2, Handled> & {
      readonly error: Schema.Schema<Handled>
    }
  ): Node<A | B, Exclude<E, Handled> | E2>
  <A, E, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2> & {
      readonly error?: undefined
    }
  ): Node<A | B, E2>
} = dual(
  2,
  <A, E, Handled, B, E2>(
    self: Node<A, E>,
    options: CatchOptions<E, B, E2, Handled>
  ): Node<A | B, Exclude<E, Handled> | E2> => {
    const subjectToken = `${catchSubject}/${catchOrdinal++}`
    const failure = options.onFailure(Planned.make<Handled>(subjectToken))
    if (!isNode(failure)) {
      throw new GraphBuildError({
        code: "invalid_continuation",
        node: catchSubject,
        path: [],
        message: "Node.catch expected its failure arm to return a Node"
      })
    }
    return internal.makeNode(internal.catch_(subjectToken, self.ast, failure.ast, options.error))
  }
)

export { catch_ as catch }

/**
 * Constructs the flow-call node used by `@smthrs/flow` without making flow
 * calls part of the public authoring surface of this package.
 *
 * @since 0.1.0
 * @private
 */
export const flowCall = <A = unknown, E = never>(
  declaration: unknown,
  flow: string,
  mode: "inline" | "boundary" | "handoff",
  payload: unknown
): Node<A, E> => internal.makeNode<A, E>(internal.flowCall(declaration, flow, mode, payload))

/**
 * Constructs the activity-call node used by `@smthrs/flow` without making
 * activity calls part of the public authoring surface of this package.
 *
 * @since 0.1.0
 * @private
 */
export const activityCall = <A = unknown, E = never>(
  declaration: unknown,
  activity: string,
  payload: unknown
): Node<A, E> => internal.makeNode<A, E>(internal.activityCall(declaration, activity, payload))

/**
 * Reads the flow or activity declaration a call node names, so `@smthrs/flow`
 * can expand a call it recorded. It is `undefined` for an AST that was
 * rehydrated from JSON, because the declaration lives beside the AST rather
 * than inside it — a graph built from such an AST keeps the call as a leaf.
 *
 * @since 0.1.0
 * @private
 */
export const declaration = (
  ast: Extract<Ast, { readonly _tag: "ActivityCall" | "FlowCall" }>
): unknown => internal.declaration(ast)

/**
 * Reads the continuation builder of a sequenced node, which graph building
 * evaluates once against a placeholder. It is `undefined` when the author
 * supplied a node directly — the topology is already in `next` — and for a
 * rehydrated AST, whose side table did not survive serialization.
 *
 * @since 0.1.0
 * @private
 */
export const continuation = (
  ast: Extract<Ast, { readonly _tag: "AndThen" }>
): ((value: Planned.Planned<unknown>) => unknown) | undefined => internal.operation(ast)

/**
 * Reads the deferred mapper of a {@link map} node, which a driver applies to
 * the real upstream value once it has one. It is `undefined` for every other
 * variant, and for a rehydrated AST whose side table did not survive
 * serialization.
 *
 * @since 0.1.0
 * @private
 */
export const mapper = (ast: Ast): ((value: unknown) => unknown) | undefined =>
  ast._tag === "Map" ? internal.operation(ast) : undefined

/**
 * Reads the run-time predicate of a {@link branch} node, which a driver
 * evaluates on the real subject value to choose an arm. It is `undefined` for
 * every other variant, and for a rehydrated AST whose side table did not
 * survive serialization.
 *
 * @since 0.1.0
 * @private
 */
export const predicate = (ast: Ast): ((value: unknown) => boolean) | undefined =>
  ast._tag === "Branch" ? internal.predicate(ast) : undefined

/**
 * Reads the optional schema selecting failures handled by a {@link catch_}.
 *
 * @since 0.1.0
 * @private
 */
export const catchFilter = (ast: Ast): Schema.Top | undefined => ast._tag === "Catch" ? internal.filter(ast) : undefined

/**
 * Digests a plan-time function the AST does NOT store — a flow's `body` —
 * exactly as the AST digests the mapper and the continuation it does store.
 * A call that keeps its callee as a leaf still has to re-key when that
 * callee's body is edited, and this is the identity it folds in.
 *
 * @since 0.1.0
 * @private
 */
export const functionIdentity = (operation: unknown): FunctionIdentity => internal.functionIdentity(operation)
