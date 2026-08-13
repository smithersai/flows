/**
 * The table a driver resolves a declared activity's implementation through.
 *
 * `docs/specs/Concepts/Unified Flow Authoring.md` splits an Activity in two: a
 * declaration that is pure data and travels everywhere, and an implementation
 * attached separately as a layer, on the hosts that can run it. A body names
 * the declaration — `Increment.call({ path })` records a node and executes
 * nothing — so whatever later drives that node has to find the implementation
 * by name, from context, at execution time. That is this service: `toLayer`
 * files the implementation here when the table is present, and a driver asks
 * for it by the tag the node carries.
 *
 * "When the table is present" means present while the implementation layer
 * ITSELF is built, so ONE table goes under the implementations AND under
 * whatever drives them:
 *
 * ```ts
 * Layer.mergeAll(Read.toLayer(read), Write.toLayer(write), Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Activity.layerImplementations)
 * )
 * ```
 *
 * Filing is a build-time effect, not a declared output, so the type checker
 * cannot catch a composition that builds one table for the implementations and
 * a second for the driver. That composition files into the first and reads the
 * second, and the driver refuses the call at run time naming the activity.
 *
 * The table is deliberately not part of `FlowRuntime`. The runtime port is what
 * a flow, an activity, or a durable wait is EXECUTED against, and an
 * implementation table is not an execution capability: it is authoring data,
 * assembled by the same layers that assemble the declarations, and every
 * runtime implementation can serve one identically.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { FlowInstance } from "../FlowRuntime/FlowInstance.ts"
import type { FlowRuntime } from "../FlowRuntime/FlowRuntime.ts"

/**
 * One declared activity's implementation, as a driver consumes it: a name to
 * resolve it by, and the durable activity a payload produces.
 *
 * `activity` returns the same `Activity.make` value `toLayer` registers with
 * the runtime, so a node driven through it takes the ordinary activity path —
 * invocation key, attempt journal, tier, retry policy — rather than a second
 * execution mechanism that would have to keep up with the first.
 *
 * @category models
 * @since 0.1.0
 */
export interface Implementation {
  readonly name: string
  readonly activity: (
    payload: unknown
  ) => Effect.Effect<unknown, unknown, FlowRuntime | FlowInstance>
}

/**
 * Service holding the declared activity implementations a composition wired
 * up, keyed by activity tag.
 *
 * **When to use**
 *
 * Use when driving a flow body, whose activity calls name declarations rather
 * than carry code. A composition that only drives behavior registered directly
 * with the runtime never needs it, which is why `Activity.toLayer` files an
 * implementation here when the service is present and skips it otherwise.
 *
 * @category services
 * @since 0.1.0
 */
export class Implementations extends Context.Service<
  Implementations,
  {
    /**
     * Files an implementation under its activity tag. A later registration of
     * the same tag replaces the earlier one. Which of two merged layers is
     * later is not a guarantee Effect makes, so a substitution replaces the
     * implementation layer in the composition rather than stacking a second
     * one on top of it.
     */
    readonly add: (implementation: Implementation) => Effect.Effect<void>

    /**
     * The implementation registered for an activity tag, if a layer supplied
     * one.
     */
    readonly get: (name: string) => Effect.Effect<Option.Option<Implementation>>
  }
>()("@smthrs/flow/Activity/Implementations") {}

/**
 * Layer providing an implementation table scoped to the composition that
 * builds it.
 *
 * The table is mutable and lives for the layer's lifetime, exactly like the
 * flow registry a runtime keeps: registration happens while layers are built,
 * and every lookup happens later, when a run drives a node. Because filing is
 * a build-time effect, provide this UNDER the implementation layers — see the
 * wiring at the top of this module — rather than merging it beside them.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerImplementations: Layer.Layer<Implementations> = Layer.effect(Implementations)(
  Effect.sync(() => {
    const registered = new Map<string, Implementation>()
    return Implementations.of({
      add: (implementation) => Effect.sync(() => void registered.set(implementation.name, implementation)),
      get: (name) => Effect.sync(() => Option.fromNullishOr(registered.get(name)))
    })
  })
)
