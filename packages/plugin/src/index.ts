/**
 * The flows plugin kernel: typed hooks, resolution and ordering, and the config
 * pipeline.
 *
 * Governing design: `docs/architecture/plugin-system.md`.
 *
 * Vault: [[Plugin Kernel]] (`docs/specs/Specs/Plugin Kernel.md`) — the shipped
 * kernel and its stated deviations from [[Plugin API]]
 * (`docs/specs/Specs/Plugin API.md`).
 *
 * @since 0.1.0
 */

import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { FlowsConfig, ResolvedConfig } from "./Config.ts"
import type {
  CheckpointContext,
  ControlRequest,
  ErrorClass,
  FirstHook,
  InconsistencyEvent,
  InconsistencyVerdict,
  ParallelHook,
  RetryContext,
  RetryDecision,
  RunContext,
  RunEndContext,
  SequentialHook,
  Shareability,
  ShareabilityContext,
  StepContext,
  StepEndContext,
  TelemetryEvent,
  WaitContext,
  WaterfallHook
} from "./Hooks.ts"

/**
 * The engine's hook catalog.
 *
 * Declared here, in the package entry point, so that the documented
 * augmentation specifier works — an interface can only be augmented in the
 * module that declares it:
 *
 * ```ts
 * declare module "@smithers/plugin" {
 *   interface FlowsHooks {
 *     toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
 *   }
 * }
 * ```
 *
 * Closed for dispatch, open for augmentation: the engine dispatches only the
 * hooks below; a harness dispatches its own through its own dispatcher
 * instance over the same augmented interface.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowsHooks {
  readonly config: WaterfallHook<(config: FlowsConfig) => Effect.Effect<Partial<FlowsConfig> | void, any, any>>
  readonly configResolved: ParallelHook<(config: ResolvedConfig) => Effect.Effect<void, any, any>>
  readonly runStart: ParallelHook<(ctx: RunContext) => Effect.Effect<void, any, any>>
  readonly runEnd: ParallelHook<(ctx: RunEndContext) => Effect.Effect<void, any, any>>
  /** A handler fails with { ControlRejected} to veto the transition. */
  readonly runControl: SequentialHook<(request: ControlRequest) => Effect.Effect<void, any, any>>
  readonly stepStart: ParallelHook<(ctx: StepContext) => Effect.Effect<void, any, any>>
  readonly stepEnd: ParallelHook<(ctx: StepEndContext) => Effect.Effect<void, any, any>>
  readonly resolveRetry: FirstHook<(ctx: RetryContext) => Effect.Effect<Option.Option<RetryDecision>, any, any>>
  readonly classifyError: FirstHook<
    (error: unknown, ctx: StepContext) => Effect.Effect<Option.Option<ErrorClass>, any, any>
  >
  readonly resolveShareability: FirstHook<
    (ctx: ShareabilityContext) => Effect.Effect<Option.Option<Shareability>, any, any>
  >
  readonly cacheInconsistency: SequentialHook<
    (event: InconsistencyEvent) => Effect.Effect<InconsistencyVerdict, any, any>
  >
  readonly waitStart: ParallelHook<(wait: WaitContext) => Effect.Effect<void, any, any>>
  readonly wake: ParallelHook<(wait: WaitContext) => Effect.Effect<void, any, any>>
  readonly checkpoint: SequentialHook<(ctx: CheckpointContext) => Effect.Effect<void, any, any>>
  readonly journalEvent: ParallelHook<(event: TelemetryEvent) => Effect.Effect<void, any, any>>
}

/**
 * @since 0.1.0
 * @category config
 */
export * as Config from "./Config.ts"

/**
 * @since 0.1.0
 * @category hooks
 */
export * from "./Hooks.ts"

/**
 * @since 0.1.0
 * @category startup
 */
export * as Kernel from "./Kernel.ts"

/**
 * @since 0.1.0
 * @category models
 */
export * from "./Plugin.ts"

/**
 * @since 0.1.0
 * @category errors
 */
export * from "./PluginError.ts"

/**
 * @since 0.1.0
 * @category dispatch
 */
export * as Plugins from "./Plugins.ts"

/**
 * @since 0.1.0
 * @category resolution
 */
export * as Resolve from "./Resolve.ts"
