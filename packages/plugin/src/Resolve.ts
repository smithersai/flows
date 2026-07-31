/**
 * Plugin resolution: flatten, filter, validate, order — once, at construction.
 *
 * Governing design: `docs/architecture/plugin-system.md`
 * ("Resolution and ordering rules"). Runtime dispatch is an array walk over the
 * frozen lists this module produces; there is no lookup and no registration
 * after start.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { FlowsConfig } from "./Config.ts"
import type { HookKind } from "./Hooks.ts"
import { engineHooks, handlerOf, orderOf } from "./Hooks.ts"
import type { FlowsHooks } from "./index.ts"
import type { FlowsPlugin, PluginInput } from "./Plugin.ts"
import { PluginError } from "./PluginError.ts"

/**
 * One resolved handler, tagged with the plugin that contributed it so failures
 * and telemetry can attribute it.
 *
 * @category models
 * @since 0.1.0
 */
export interface HandlerRecord {
  readonly plugin: string
  readonly hook: string
  readonly handler: (...args: Array<any>) => unknown
}

/**
 * The frozen output of resolution.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolved<H = FlowsHooks> {
  readonly plugins: ReadonlyArray<FlowsPlugin<H>>
  readonly handlers: ReadonlyMap<string, ReadonlyArray<HandlerRecord>>
}

/**
 * Options for {@link resolve}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Pre-resolution config that `apply` predicates are tested against. */
  readonly config?: FlowsConfig | undefined
  /** Which host is resolving; matched against a string `apply`. */
  readonly target?: "engine" | "harness" | undefined
  /** Hook names recognized by this host. Defaults to the engine catalog. */
  readonly hooks?: Readonly<Record<string, HookKind>> | undefined
}

const flatten = <H>(input: PluginInput<H>, into: Array<FlowsPlugin<H>>): Array<FlowsPlugin<H>> => {
  if (!input) return into
  if (Array.isArray(input)) {
    for (const entry of input as ReadonlyArray<PluginInput<H>>) flatten(entry, into)
    return into
  }
  into.push(input as FlowsPlugin<H>)
  return into
}

const included = <H>(plugin: FlowsPlugin<H>, options: Options): boolean => {
  const apply = plugin.apply
  if (apply === undefined) return true
  if (typeof apply === "function") return apply(options.config ?? {})
  return apply === (options.target ?? "engine")
}

const rank = (enforce: "pre" | "post" | undefined): number => (enforce === "pre" ? 0 : enforce === "post" ? 2 : 1)

/**
 * Flattens, filters, validates, and orders a plugin list.
 *
 * Fails with `duplicate_name` when two plugins share a name (never last-wins)
 * and with `unknown_hook` when a dynamically built plugin carries a hook key
 * this host does not declare.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolve = <H = FlowsHooks>(
  input: PluginInput<NoInfer<H>>,
  options: Options = {}
): Effect.Effect<Resolved<H>, PluginError> =>
  Effect.suspend(() => {
    const known = options.hooks ?? engineHooks
    const flat = flatten<H>(input, []).filter((plugin) => included(plugin, options))

    const seen = new Set<string>()
    for (const plugin of flat) {
      if (seen.has(plugin.name)) {
        return Effect.fail(
          new PluginError({
            code: "duplicate_name",
            message: `duplicate plugin name "${plugin.name}"`,
            plugin: plugin.name
          })
        )
      }
      seen.add(plugin.name)
      for (const hook of Object.keys(plugin.hooks ?? {})) {
        if (!(hook in known)) {
          return Effect.fail(
            new PluginError({
              code: "unknown_hook",
              message: `plugin "${plugin.name}" declares unknown hook "${hook}"`,
              plugin: plugin.name,
              hook
            })
          )
        }
      }
    }

    // Stable partition by `enforce`: pre, normal, post.
    const plugins = flat
      .map((plugin, index) => ({ plugin, index }))
      .sort((left, right) => rank(left.plugin.enforce) - rank(right.plugin.enforce) || left.index - right.index)
      .map(({ plugin }) => plugin)

    const handlers = new Map<string, ReadonlyArray<HandlerRecord>>()
    for (const hook of Object.keys(known)) {
      const buckets: [Array<HandlerRecord>, Array<HandlerRecord>, Array<HandlerRecord>] = [[], [], []]
      for (const plugin of plugins) {
        const entry = (plugin.hooks as Record<string, unknown> | undefined)?.[hook]
        if (entry === undefined || entry === null) continue
        const bucket = rank(orderOf(entry))
        ;(bucket === 0 ? buckets[0] : bucket === 2 ? buckets[2] : buckets[1]).push({
          plugin: plugin.name,
          hook,
          handler: handlerOf(entry)
        })
      }
      const flatBucket = [...buckets[0], ...buckets[1], ...buckets[2]]
      if (flatBucket.length > 0) handlers.set(hook, Object.freeze(flatBucket))
    }

    return Effect.succeed(
      Object.freeze({ plugins: Object.freeze(plugins), handlers })
    )
  })

/**
 * Merges every resolved plugin's `layer` left-to-right with
 * `Layer.provideMerge`, so a `pre` plugin's services are visible to the layers
 * that follow it.
 *
 * Returns `Layer.empty` when no plugin contributes a layer.
 *
 * @category combinators
 * @since 0.1.0
 */
export const layer = <H>(resolved: Resolved<H>): Layer.Layer<any, PluginError, any> => {
  const layers = resolved.plugins.flatMap((plugin) =>
    plugin.layer
      ? [
        Layer.catchCause(plugin.layer, (cause) =>
          Layer.effectDiscard(
            Effect.fail(
              new PluginError({
                code: "layer_failed",
                message: `plugin "${plugin.name}" failed to build its layer`,
                plugin: plugin.name,
                cause
              })
            )
          )) as Layer.Layer<any, PluginError, any>
      ]
      : []
  )
  if (layers.length === 0) return Layer.empty as unknown as Layer.Layer<any, PluginError, any>
  return layers.reduce((accumulated, next) => Layer.provideMerge(next, accumulated))
}
