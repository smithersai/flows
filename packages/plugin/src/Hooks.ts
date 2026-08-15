/**
 * The typed hook surface: hook kinds, the hook entry shape, and the engine's
 * hook catalog.
 *
 * Governing design: `docs/architecture/plugin-system.md` ("The hook catalog").
 *
 * Vault: [[Plugin Kernel]] (`docs/specs/Specs/Plugin Kernel.md`) — the shipped
 * kernel and its stated deviations from [[Plugin API]]
 * (`docs/specs/Specs/Plugin API.md`).
 *
 * `FlowsHooks` is **open for augmentation, closed for dispatch**: a harness
 * declares its own hooks with `declare module "@smthrs/plugin"` and holds its
 * own dispatcher over the augmented interface, while the engine dispatches only
 * the hooks it declared here.
 *
 * Payload types are minimal structural placeholders — consumers (engine,
 * harness) wire the real ones in a later round. The *signatures* are the
 * contract.
 *
 * @since 0.1.0
 */
import type * as Effect from "effect/Effect"

/**
 * Dispatch semantics of a hook, fixed by the core.
 *
 * @category models
 * @since 0.1.0
 */
export type HookKind = "sequential" | "parallel" | "first" | "waterfall"

declare const HookTypeId: unique symbol

/**
 * Phantom carrier that records a hook's kind and handler type in the type
 * system without adding anything at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface HookMeta<K extends HookKind, F> {
  readonly [HookTypeId]?: { readonly kind: K; readonly handler: F }
}

/**
 * The object form of a hook entry — Vite's per-hook ordering object, verbatim.
 *
 * @category models
 * @since 0.1.0
 */
export interface HookObject<F> {
  readonly order?: "pre" | "post" | undefined
  readonly handler: F
}

/**
 * A hook entry is either the bare handler or `{ order?, handler }`.
 *
 * @category models
 * @since 0.1.0
 */
export type HookEntry<K extends HookKind, F> = (F | HookObject<F>) & HookMeta<K, F>

/**
 * Every handler runs, in resolved order, one at a time.
 *
 * @category models
 * @since 0.1.0
 */
export type SequentialHook<F> = HookEntry<"sequential", F>

/**
 * Every handler runs concurrently; results are ignored and failures are
 * surfaced for journalling rather than failing the caller.
 *
 * @category models
 * @since 0.1.0
 */
export type ParallelHook<F> = HookEntry<"parallel", F>

/**
 * Handlers run in order until one returns `Option.some`.
 *
 * @category models
 * @since 0.1.0
 */
export type FirstHook<F> = HookEntry<"first", F>

/**
 * Each handler receives the previous handler's output. Config only.
 *
 * @category models
 * @since 0.1.0
 */
export type WaterfallHook<F> = HookEntry<"waterfall", F>

/**
 * Extracts the declared kind of a hook entry type.
 *
 * @category type-level
 * @since 0.1.0
 */
export type KindOf<T> = T extends HookMeta<infer K, any> ? K : never

/**
 * Extracts the handler type of a hook entry type.
 *
 * @category type-level
 * @since 0.1.0
 */
export type HandlerOf<T> = T extends HookMeta<any, infer F> ? F : never

/**
 * Selects the hook names of a given kind from a hook interface.
 *
 * @category type-level
 * @since 0.1.0
 */
export type KeysOfKind<H, K extends HookKind> =
  & {
    [P in keyof H]: KindOf<H[P]> extends K ? P : never
  }[keyof H]
  & string

/** @internal */
export type ArgsOf<T> = HandlerOf<T> extends (...args: infer A) => any ? A : never

/** @internal */
export type ReturnOf<T> = HandlerOf<T> extends (...args: any) => infer R ? R : never

/** @internal */
export type SuccessOf<T> = ReturnOf<T> extends Effect.Effect<infer A, any, any> ? A : never

/** @internal */
export type ContextOf<T> = ReturnOf<T> extends Effect.Effect<any, any, infer R> ? R : never

/**
 * Opaque identifier of a run. Placeholder until the engine exports its own.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = string

/**
 * Transient/permanent failure classification.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorClass = "transient" | "permanent"

/**
 * Outcome of the `resolveRetry` decision point.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryDecision = { readonly delayMs: number } | { readonly giveUp: unknown }

/**
 * Whether a settled result may be shared through the content-addressed cache.
 *
 * @category models
 * @since 0.1.0
 */
export type Shareability = { readonly shareable: true } | { readonly shareable: false; readonly reason: string }

/**
 * Verdict of the `cacheInconsistency` hook; first `"fail"` wins after every
 * handler has observed the event.
 *
 * @category models
 * @since 0.1.0
 */
export type InconsistencyVerdict = "fail" | "tolerate"

/**
 * Minimal structural placeholder for an activity descriptor.
 *
 * @category models
 * @since 0.1.0
 */
export interface ActivityMeta {
  readonly name: string
  readonly [key: string]: unknown
}

/**
 * Minimal structural placeholder for a step call site.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepContext {
  readonly runId: RunId
  readonly stepKey: string
  readonly attempt?: number | undefined
}

/**
 * Minimal structural placeholder for a run call site.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunContext {
  readonly runId: RunId
}

/**
 * Terminal transition observed by `runEnd`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunEndContext extends RunContext {
  readonly outcome: "success" | "failure" | "cancelled" | "continued"
}

/**
 * Result and boundary evidence observed by `stepEnd`.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepEndContext extends StepContext {
  readonly outcome: "success" | "failure"
  readonly evidence?: unknown
}

/**
 * A pause / resume / cancel / hijack request, vetoable by `runControl`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ControlRequest {
  readonly verb: "pause" | "resume" | "cancel" | "hijack"
  readonly actor: string
  readonly reason?: string | undefined
  readonly runId: RunId
}

/**
 * Typed veto of a control request.
 *
 * @category models
 * @since 0.1.0
 */
export interface ControlRejected {
  readonly _tag: "ControlRejected"
  readonly reason: string
}

/**
 * Waiting-reason taxonomy entry observed by `waitStart` / `wake`.
 *
 * @category models
 * @since 0.1.0
 */
export interface WaitContext {
  readonly runId: RunId
  readonly reason: "approval" | "event" | "timer" | "quota" | (string & {})
  readonly wakeAt?: number | undefined
  readonly token?: string | undefined
}

/**
 * Cache row placeholder; the real row type lives in `@smthrs/journal`.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheRow {
  readonly [key: string]: unknown
}

/**
 * The `CacheStore.put` conflict observed by `cacheInconsistency`.
 *
 * @category models
 * @since 0.1.0
 */
export interface InconsistencyEvent {
  readonly key: string
  readonly existing: CacheRow
  readonly attempted: CacheRow
}

/**
 * Retry decision point context.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetryContext {
  readonly attempt: number
  readonly error: unknown
  readonly classification: ErrorClass
  readonly activity: ActivityMeta
}

/**
 * Shareability decision point context.
 *
 * @category models
 * @since 0.1.0
 */
export interface ShareabilityContext {
  readonly tier: string
  readonly boundaryMode: string
  readonly evidence?: unknown
}

/**
 * Step-boundary snapshot request; requires a `Checkpoint` host capability
 * contributed by the plugin's own layer.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckpointContext {
  readonly runId: RunId
  readonly stepKey: string
  readonly seq: number
}

/**
 * An entry on the lossy telemetry channel. `journalEvent` observers can never
 * see, delay, or veto the durable lifecycle stream.
 *
 * @category models
 * @since 0.1.0
 */
export interface TelemetryEvent {
  readonly runId: RunId
  readonly type: string
  readonly payload?: unknown
}

/**
 * Runtime catalog of the engine's hook names and kinds.
 *
 * The type system cannot enumerate an augmentable interface, so this constant
 * is what the `unknown_hook` guard checks against. A harness passes its own
 * superset to {@link resolve}.
 *
 * @category models
 * @since 0.1.0
 */
export const engineHooks: Readonly<Record<string, HookKind>> = Object.freeze({
  config: "waterfall",
  configResolved: "parallel",
  runStart: "parallel",
  runEnd: "parallel",
  runControl: "sequential",
  stepStart: "parallel",
  stepEnd: "parallel",
  resolveRetry: "first",
  classifyError: "first",
  resolveShareability: "first",
  cacheInconsistency: "sequential",
  waitStart: "parallel",
  wake: "parallel",
  checkpoint: "sequential",
  journalEvent: "parallel"
})

/**
 * Normalizes a hook entry to its handler.
 *
 * @category utils
 * @since 0.1.0
 */
export const handlerOf = (entry: unknown): (...args: Array<any>) => unknown =>
  typeof entry === "function"
    ? entry as (...args: Array<any>) => unknown
    : (entry as HookObject<(...args: Array<any>) => unknown>).handler

/**
 * Reads the per-hook `order` of a hook entry.
 *
 * @category utils
 * @since 0.1.0
 */
export const orderOf = (entry: unknown): "pre" | "post" | undefined =>
  typeof entry === "function" ? undefined : (entry as HookObject<unknown>).order
