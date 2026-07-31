/**
 * Configuration shapes consumed and produced by the plugin kernel.
 *
 * Governing design: `docs/architecture/plugin-system.md`.
 *
 * Vault: [[Plugin Kernel]] (`docs/specs/Specs/Plugin Kernel.md`) — the shipped
 * kernel and its stated deviations from [[Plugin API]]
 * (`docs/specs/Specs/Plugin API.md`).
 *
 * The types here are deliberately minimal structural placeholders: the engine
 * and the harness wire their real option groups in a later round. What is
 * contractual today is the *shape of the pipeline* — a mutable `FlowsConfig`
 * threaded through the `config` waterfall, decoded, defaulted, and frozen into
 * a `ResolvedConfig` that is immutable for the process lifetime.
 *
 * `plugins` is typed `unknown` on purpose. The plugin list lives on the config
 * the application assembles, but typing it as `PluginInput` here would make
 * `Config` depend on `Plugin`, which depends on `Hooks`, which depends on
 * `Config`. The kernel never reads `plugins` off a config value.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PluginError } from "./PluginError.ts"

/**
 * Retry defaults consumed by the core `resolveRetry` fallback policy.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetryConfig {
  readonly maxAttempts?: number | undefined
  readonly initialDelayMs?: number | undefined
  readonly backoffCoefficient?: number | undefined
  readonly maxDelayMs?: number | undefined
}

/**
 * Engine-level knobs.
 *
 * @category models
 * @since 0.1.0
 */
export interface EngineConfig {
  readonly maxConcurrency?: number | undefined
}

/**
 * The pre-resolution configuration an application assembles.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowsConfig {
  readonly plugins?: unknown
  readonly retry?: RetryConfig | undefined
  readonly engine?: EngineConfig | undefined
  readonly store?: { readonly url?: string | undefined } | undefined
}

/**
 * The frozen configuration handed to `configResolved` and to the engine.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedConfig {
  readonly retry: {
    readonly maxAttempts: number
    readonly initialDelayMs: number
    readonly backoffCoefficient: number
    readonly maxDelayMs: number
  }
  readonly engine: { readonly maxConcurrency: number }
  readonly store: { readonly url?: string | undefined }
}

/**
 * Schema used to decode the post-waterfall configuration.
 *
 * A decode failure is the `config_invalid` error code.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FlowsConfigSchema = Schema.Struct({
  plugins: Schema.optional(Schema.Unknown),
  retry: Schema.optional(Schema.Struct({
    maxAttempts: Schema.optional(Schema.Finite),
    initialDelayMs: Schema.optional(Schema.Finite),
    backoffCoefficient: Schema.optional(Schema.Finite),
    maxDelayMs: Schema.optional(Schema.Finite)
  })),
  engine: Schema.optional(Schema.Struct({ maxConcurrency: Schema.optional(Schema.Finite) })),
  store: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.String) }))
})

/**
 * Defaults applied after the `config` waterfall and before freezing.
 *
 * @category models
 * @since 0.1.0
 */
export const defaults: ResolvedConfig = Object.freeze({
  retry: Object.freeze({
    maxAttempts: 3,
    initialDelayMs: 1_000,
    backoffCoefficient: 2,
    maxDelayMs: 60_000
  }),
  engine: Object.freeze({ maxConcurrency: 16 }),
  store: Object.freeze({})
})

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Deep-merges a partial configuration patch over a base configuration.
 *
 * Plain objects merge key-by-key; every other value (including arrays)
 * replaces wholesale. `undefined` never clobbers a present value.
 *
 * @category combinators
 * @since 0.1.0
 */
export const merge = <A>(base: A, patch: unknown): A => {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as A
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    const next = patch[key]
    if (next === undefined) continue
    result[key] = isPlainObject(result[key]) && isPlainObject(next) ? merge(result[key], next) : next
  }
  return result as A
}

/**
 * Decodes a post-waterfall configuration, applies defaults, and deep-freezes
 * the result.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolve = (config: FlowsConfig): Effect.Effect<ResolvedConfig, PluginError> =>
  Schema.decodeUnknownEffect(FlowsConfigSchema)(config).pipe(
    Effect.mapError((cause) =>
      new PluginError({ code: "config_invalid", message: "post-waterfall config failed decoding", cause })
    ),
    Effect.map((decoded) => deepFreeze(merge(defaults, { ...decoded, plugins: undefined })))
  )

/**
 * Recursively freezes a value's own enumerable object properties.
 *
 * @category utils
 * @since 0.1.0
 */
export const deepFreeze = <A>(value: A): A => {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return typeof value === "object" && value !== null ? Object.freeze(value) : value
}
