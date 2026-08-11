/**
 * The body interpreter: what a bodied flow does when it runs.
 *
 * A `Flow` with a `body` has no handler to register — the body IS the
 * behavior, per `docs/specs/Concepts/Unified Flow Authoring.md` — so something
 * has to turn the graph that body describes into execution. That is this
 * module. {@link layer} registers a bodied flow with the runtime, and the
 * handler it installs builds the graph with {@link module:Graph.build} and
 * walks it: each node settles once, in dependency order, and the root's value
 * is the flow's result.
 *
 * What each variant does is the run-time half of what the AST recorded. An
 * `ActivityCall` runs its declaration's implementation — looked up by tag in
 * {@link module:Implementations.Implementations} before the walk starts — as
 * the ordinary durable activity `toLayer` built, so a node driven here takes
 * the same invocation key, attempt journal, retry policy, and tier as the same
 * activity called from a handler. A `Map` applies its deferred function to the real
 * upstream value. A `Branch` evaluates its digested predicate on the real
 * subject and settles ONLY the arm it took: the other arm is topology the plan
 * shows and the run skipped, and it is reported as such rather than silently
 * absent. An `All` joins its members by name, a `Succeed` yields its value, and
 * an inline `FlowCall` was already flattened by graph building, so it settles
 * with the body spliced beneath it.
 *
 * Planned references are resolved the way the plan names them: a payload
 * placeholder carries the `Ref` `{from, path}` its key material recorded, so
 * `result.files` reads `files` off the settled value of the node that produced
 * it.
 *
 * The walk is demand-driven from the root rather than a sweep over the node
 * list, because dependency order puts BOTH branch arms before the branch that
 * chooses between them, and executing an arm to discover it was not taken is
 * exactly what static topology exists to avoid.
 *
 * @since 0.1.0
 */
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { type Implementation, Implementations } from "./Activity/Implementations.ts"
import type { AnyStructSchema, Flow } from "./Flow/Flow.ts"
import type * as FlowInstance from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import * as Graph from "./Graph.ts"

/**
 * A graph the interpreter will not drive.
 *
 * Every code names something the run cannot recover from on its own: a flow
 * with nothing to interpret, a graph whose topology is incomplete, an activity
 * with no implementation wired up, a call the interpreter does not execute, and
 * a deferred function that did not survive serialization beside its AST.
 *
 * @category errors
 * @since 0.1.0
 */
export class InterpreterError extends Schema.TaggedErrorClass<InterpreterError>()(
  "@smthrs/flow/InterpreterError",
  {
    code: Schema.Literals([
      "missing_body",
      "incomplete_graph",
      "unresolved_activity",
      "unresolved_reference",
      "unsupported_call",
      "missing_operation"
    ]),
    flow: Schema.String,
    node: Schema.String,
    message: Schema.String
  }
) {}

/**
 * What one interpretation produced: the root's value, every node that settled
 * with the value it settled with, and the nodes the run never reached because
 * a branch went the other way.
 *
 * @category models
 * @since 0.1.0
 */
export interface Interpretation {
  readonly value: unknown
  readonly settled: ReadonlyMap<string, unknown>
  readonly skipped: ReadonlyArray<string>
}

/**
 * The services a driven node needs: the runtime that executes an activity, and
 * the execution it is part of.
 *
 * @private
 */
type Services = FlowRuntime | FlowInstance.FlowInstance | Implementations

/**
 * Whether a value is a record to walk into. Everything a payload can carry
 * here came out of the AST, which holds JSON and placeholders only, so an
 * object that is not an array is a record.
 *
 * @private
 */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * Interprets a flow body, or a bare node, against real values.
 *
 * The graph is built first and in full — planning is a pure function of the
 * declarations and the payload, so the whole shape of the round is known before
 * the first activity runs — and then driven.
 *
 * @since 0.1.0
 * @category constructors
 */
export const interpret = (
  flowOrNode: Parameters<typeof Graph.build>[0],
  payload?: unknown,
  options: Graph.BuildOptions = {}
): Effect.Effect<Interpretation, unknown, Services> =>
  Effect.gen(function*() {
    const table = yield* Implementations
    const name = "_tag" in flowOrNode ? flowOrNode._tag : "node"
    const graph = Graph.build(flowOrNode, payload, options)
    const refuse = (
      code: InterpreterError["code"],
      node: string,
      message: string
    ): Effect.Effect<never, InterpreterError> => Effect.fail(new InterpreterError({ code, flow: name, node, message }))

    if (graph.diagnostics.length > 0) {
      const first = graph.diagnostics[0]!
      return yield* refuse(
        "incomplete_graph",
        first.node,
        `Graph of "${name}" is missing topology and cannot be driven: ${first.message}`
      )
    }

    const byId = new Map(Graph.nodes(graph).map((node) => [node.id, node] as const))
    // Everything the walk needs that the built graph can be asked for before it
    // runs, is asked for here — so neither refusal can surface halfway through a
    // body with the activities ahead of it already committed.
    //
    // A reference out of the graph is the first: a round may be PLANNED against
    // a node an earlier generation settled — `Plan.append` exists for exactly
    // that — but one interpretation settles one graph, so there is nothing to
    // read it from. A missing implementation is the second, and it is a wiring
    // error rather than a run-time contingency: every activity the graph names
    // is resolved up front, including the ones only an untaken branch arm would
    // have reached, because the plan is the declared ceiling of what may run.
    const implementations = new Map<string, Implementation>()
    for (const node of Graph.nodes(graph)) {
      for (const dependency of KeyMaterial.dependencies(node.draft.material)) {
        if (byId.has(dependency)) continue
        return yield* refuse(
          "unresolved_reference",
          node.id,
          `Node "${node.id}" reads "${dependency}", which this graph does not hold.`
        )
      }
      if (node.ast._tag !== "ActivityCall") continue
      const implementation = yield* table.get(node.ast.activity)
      if (Option.isNone(implementation)) {
        return yield* refuse(
          "unresolved_activity",
          node.id,
          `Activity "${node.ast.activity}" has no implementation. ` +
            `Provide ONE Activity.layerImplementations under both ${node.ast.activity}.toLayer(execute) and ` +
            "this interpreter layer: an implementation files itself with the table that is in scope " +
            "while IT is built, so a table merged beside it, or a second one built above it, is not the " +
            "table this driver reads."
        )
      }
      implementations.set(node.ast.activity, implementation.value)
    }
    // The children a node settles with, in the order graph building recorded
    // them: `first` then the arms of a branch, `first` then the continuation of
    // a sequence, the members of a combination, the spliced body of an inline
    // call. Payload references are NOT here — they are named by the key
    // material, and settled from it.
    const sources = new Map<string, Array<string>>()
    for (const edge of Graph.edges(graph)) {
      if (edge.reason !== "value") continue
      sources.set(edge.to, [...sources.get(edge.to) ?? [], edge.from])
    }

    const settled = new Map<string, unknown>()

    /** Projects a settled value along the property path a `Ref` recorded. */
    const project = (value: unknown, path: ReadonlyArray<string>): unknown =>
      path.reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], value)

    /**
     * Replaces every placeholder in a hydrated payload with what it stands for.
     *
     * The record is rebuilt with a null prototype and `defineProperty`, for the
     * reason {@link module:Graph.build}'s cloners are: `output[key] = …` on an
     * object literal routes `__proto__` through `Object.prototype`'s accessor,
     * which drops an own `__proto__` field carrying a primitive and reparents
     * the clone when it carries an object. A graph hydrates that field as data,
     * so the value handed to an activity has to keep it as data too.
     */
    const resolve = (value: unknown): unknown => {
      const reference = Planned.reference(value)
      if (reference !== undefined) return project(settled.get(reference.node), reference.path)
      if (Array.isArray(value)) return value.map((item) => resolve(item))
      if (!isRecord(value)) return value
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value)) {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: resolve(value[key]),
          writable: true
        })
      }
      return output
    }

    // OPEN QUESTION (2026-08-11): PlanScheduler as the driver
    // Untraced because the walk re-enters itself once per node.
    const settle: (id: string) => Effect.Effect<unknown, unknown, Services> = Effect.fnUntraced(
      function*(id: string) {
        if (settled.has(id)) return settled.get(id)
        const value = yield* compute(byId.get(id)!)
        settled.set(id, value)
        return value
      }
    )

    const compute: (node: Graph.GraphNode) => Effect.Effect<unknown, unknown, Services> = Effect.fnUntraced(
      function*(node: Graph.GraphNode) {
        const children = sources.get(node.id) ?? []
        const ast = node.ast
        if (ast._tag === "Branch") {
          // The predicate decides on the REAL value, and only the arm it chose
          // is settled. Both arms are still in the plan; the untaken one is
          // reported as skipped.
          const decide = Node.predicate(ast)
          if (decide === undefined) {
            return yield* refuse("missing_operation", node.id, `Branch at "${node.id}" lost its predicate.`)
          }
          const subject = yield* settle(children[0]!)
          return yield* settle(decide(subject) ? children[1]! : children[2]!)
        }
        // Dependency order, from the key material: the same `Ref` and `Pending`
        // inputs the plan turns into edges, settled before the node that reads
        // them.
        for (const dependency of KeyMaterial.dependencies(node.draft.material)) {
          yield* settle(dependency)
        }
        switch (ast._tag) {
          case "ActivityCall":
            // Resolved by the pre-pass above, which refuses the whole graph
            // when an activity it names has no implementation.
            return yield* implementations.get(ast.activity)!.activity(resolve(node.payload))
          case "Succeed":
            return resolve(node.payload)
          case "Map": {
            const transform = Node.mapper(ast)
            if (transform === undefined) {
              return yield* refuse("missing_operation", node.id, `Map at "${node.id}" lost its mapper.`)
            }
            return transform(yield* settle(children[0]!))
          }
          case "All": {
            const joined: Record<string, unknown> = {}
            const members = Object.keys(ast.nodes)
            for (let index = 0; index < members.length; index++) {
              joined[members[index]!] = yield* settle(children[index]!)
            }
            return joined
          }
          case "AndThen":
            return yield* settle(children[1]!)
          case "FlowCall": {
            const spliced = children[0]
            if (spliced === undefined) {
              return yield* refuse(
                "unsupported_call",
                node.id,
                `Flow "${ast.flow}" is called at "${node.id}" as a leaf, which this interpreter does not drive. ` +
                  "An inline .call() of a flow that has a body is spliced into the graph and driven with it."
              )
            }
            return yield* settle(spliced)
          }
        }
      }
    )

    const value = yield* settle(options.root ?? "root")
    return {
      value,
      settled,
      skipped: Graph.nodes(graph).filter((node) => !settled.has(node.id)).map((node) => node.id)
    }
  })

/**
 * Registers a bodied flow with the runtime, driven by its body.
 *
 * This is the bodied counterpart of `toLayer`, and the reason `toLayer` refuses
 * a bodied flow: a flow has one behavior, and for this one it is the body.
 * Compose it beside the activity implementation layers the body calls, over the
 * {@link module:Implementations.layerImplementations} table they file
 * themselves in — the table goes UNDER them, because filing happens while an
 * implementation layer is built:
 *
 * ```ts
 * Layer.mergeAll(Read.toLayer(read), Write.toLayer(write), Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Activity.layerImplementations)
 * )
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = <
  Tag extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  flow: Flow<Tag, Payload, Success, Error>,
  options: Graph.BuildOptions = {}
): Layer.Layer<
  never,
  never,
  | FlowRuntime
  | Implementations
  | Payload["DecodingServices"]
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Success["EncodingServices"]
  | Error["DecodingServices"]
  | Error["EncodingServices"]
> =>
  Layer.effectDiscard(Effect.gen(function*() {
    if (flow.body === undefined) {
      return yield* Effect.die(
        new InterpreterError({
          code: "missing_body",
          flow: flow._tag,
          node: options.root ?? "root",
          message: `Flow "${flow._tag}" has no body to interpret. ` +
            `Give it one, or register its behavior with ${flow._tag}.toLayer(execute).`
        })
      )
    }
    const runtime = yield* FlowRuntime
    yield* runtime.register(
      flow,
      ((payload: Payload["Type"]) =>
        Effect.map(
          interpret(flow, payload, options),
          (interpretation) => interpretation.value
        )) as (payload: Payload["Type"], executionId: string) => Effect.Effect<
          Success["Type"],
          Error["Type"],
          Implementations
        >
    )
  }))
