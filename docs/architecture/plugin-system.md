# Plugin system (`@smithers/plugin`)

Status: **kernel implemented, seams not yet dispatched**. This document is the contract. `packages/plugin` implements the plugin object, resolution and ordering, the config waterfall, and the four hook dispatch kinds; the engine call sites listed below still use their built-in defaults and will dispatch through the kernel in a later round. The package name is `@smithers/plugin` — no reason was found to deviate: it sits beside `@smithers/kernel` and `@smithers/host` in the existing namespace, and the harness above the engine will depend on it under the same name.

## Motivation

The engine's maintainer directive is: keep the architecture simple and pluggable, with a plugin system modeled on Vite's API as the main way of adding functionality — and the same plugin system must serve the agent harness being built on top of this engine.

Three audits (Skyframe, Temporal, Smithers-classic) each surfaced robustness features that would otherwise land as inline special cases in `packages/engine-store/src/internal/ActivityPersistence.ts` and friends: cache-conflict handling, shareability predicates, retry-policy resolution, error classification, quota parking, checkpointing, supervisor sweeps, pause/hijack attribution. Every one of those is a *policy* at a *seam*, not core mechanism. The plugin system is where those policies live, so the core stays small and the executor never grows another `if`.

What made Vite's plugin API the ecosystem's most loved, distilled:

1. **A small typed hook surface at real lifecycle seams** — not "events for everything", but a curated catalog where each hook corresponds to a decision the core genuinely delegates.
2. **Plugins are plain objects returned by factory functions** — no classes, no registration ceremony; a plugin is data plus closures.
3. **Ordering is data** (`enforce: "pre" | "post"`, array position), never callback-registration order or priority integers.
4. **Config is a first-class hook target** — plugins shape the resolved config before anything runs, then read the frozen result.
5. **Hook kinds are explicit** — sequential (each runs, in order), first (first non-null answer wins), and waterfall (each transforms the previous result). The caller's semantics are visible in the type, not in prose.

We keep that shape and make it Effect-native: every hook returns an `Effect`, plugins contribute `Layer`s, ordering and composition are data resolved once at startup, and cancellation is fiber interruption — a hook running when its run's scope closes is interrupted like any other fiber; there is no `AbortSignal` threading.

Reference basis (per the corpus rule): `reference/effect` Layer idioms and `unstable/workflow` for the engine seams; `reference/opencode` `packages/core/src/effect` for how a shipping Effect harness does DI (services as `Context.Tag`s wired by a single app layer — our plugins contribute into exactly that composition); Vite/Rollup for the hook-object shape. Deviations are called out inline.

## Non-goals

- Not a module graph. Vite's `resolveId`/`load`/`transform` triad exists because Vite transforms modules. Flows are Effect code, not sources to rewrite — there is **no transform hook** and no virtual-module analogue.
- Not an event bus. Hooks are typed call sites owned by the core; plugins cannot invent hooks or emit to each other. Cross-plugin communication happens the Effect way: a plugin exposes a service via its `layer`, another plugin requires it.
- Not a sandbox. Plugins are trusted code composed by the application author, like Vite plugins. Capability enforcement remains the kernel's job. **Deviation, stated:** `docs/specs/Specs/Plugin API.md` says "plugins are untrusted" and declares a `capabilities` field. That is deferred, not rejected — it needs `Permission Kernel` enforcement for plugin-provided layers at the `Host Adapters` boundary, and a `capabilities` field that nothing enforces would be a type that lies. See `docs/specs/Specs/Plugin Kernel.md` for the full deviation record.

## The plugin object

```ts
import type { Layer } from "effect"
import type { FlowsHooks, ResolvedConfig, FlowsConfig } from "@smithers/plugin"

export interface FlowsPlugin {
  /** Required, unique. Convention: "flows-plugin-<thing>" or "@scope/flows-plugin-<thing>". */
  readonly name: string
  /** Ordering group. Omitted = "normal". */
  readonly enforce?: "pre" | "post"
  /** Conditional inclusion, like Vite's `apply: "build" | "serve"`.
   *  "engine" = durable core only; "harness" = only when a harness host runs it. */
  readonly apply?: "engine" | "harness" | ((config: FlowsConfig) => boolean)
  /** Services this plugin contributes to the engine environment.
   *  May require only services the engine environment already provides
   *  (Host, Journal, stores) — this is what keeps the core browser-safe:
   *  a plugin never touches the machine except through a Host layer. */
  readonly layer?: Layer.Layer<any, never, EngineEnv>
  /** Typed hooks. Only keys declared in FlowsHooks compile. */
  readonly hooks?: Partial<FlowsHooks>
}
```

A plugin is produced by a factory (options in, object out), exactly Vite's convention:

```ts
export const quotaPark = (options?: { readonly wakeSlackMs?: number }): FlowsPlugin => ({
  name: "flows-plugin-quota-park",
  hooks: { /* see example below */ },
})
```

`hooks` is `Partial<FlowsHooks>` where `FlowsHooks` is a **closed interface**: a misspelled or unknown hook name is a compile error (excess-property checking on the object literal, plus a runtime `PluginError` with code `unknown_hook` as a belt-and-braces guard for dynamically built plugins).

### Hook values and hook kinds

Each entry in `FlowsHooks` is either the bare handler or `{ order?: "pre" | "post", handler }` — Vite's per-hook ordering object, verbatim. Handlers return Effects. The *kind* of each hook is fixed by the core and encoded in the registry types:

- **sequential** — every matching handler runs, in resolved order, one at a time. Used where side-effect order matters.
- **parallel** — every handler runs concurrently (`Effect.forEach` with unbounded concurrency inside the calling fiber's scope); results ignored. Used for observers.
- **first** — handlers run in order until one returns `Option.some`; the rest are skipped. Used for pluggable decisions with a core default fallback.
- **waterfall** — each handler receives the previous handler's output and returns the next. Used only for config.

Hook failures are typed: a handler that fails does so with its declared error channel, and the engine wraps it as `PluginError` (see error codes) — sequential/first hook failure fails the calling operation; parallel observer failure is journalled and does not fail the run (observers are lossy by contract, mirroring the journal's `emitLossy` channel).

## Config story

Mirrors Vite exactly, with Effect types:

1. The application assembles a `FlowsConfig` (plugin list, store options, retry defaults, engine options). `plugins` accepts nested arrays and falsy values; the list is flattened and filtered, so a preset is just a function returning `FlowsPlugin[]`.
2. **`config` hook (waterfall, sequential)**: each plugin may return a partial config to be deep-merged, or mutate-and-return. Runs before any Layer is built. Namespaces outside the known option groups (`retry`/`engine`/`store`) are carried through resolution verbatim and deep-frozen — a plugin's own namespace (e.g. `myPlugin: { endpoint }`) is readable from the resolved config; the plugin validates it itself.
3. The core resolves defaults, producing a frozen `ResolvedConfig`.
4. **`configResolved` hook (parallel)**: plugins capture the final config. After this point config is immutable for the process lifetime.
5. All plugin `layer`s are merged (in resolved order, `Layer.provideMerge` left-to-right so `pre` plugins' services are visible to later ones) into the engine's environment. This composed layer is the single place plugins meet DI — the same shape opencode uses for its app layer.

## Resolution and ordering rules

Identical to Vite's, restated as the contract:

1. Flatten `plugins`, drop falsy entries.
2. Apply `apply` filters against the pre-resolution config.
3. Duplicate `name`s are a startup error (`PluginError`, code `duplicate_name`) — not last-wins.
4. Partition into `pre` / normal / `post` by `enforce`; stable order within each partition is array order. Final order: pre, normal, post.
5. Per-hook `order: "pre" | "post"` re-partitions *within that hook only*, again stably.
6. Resolution happens once, at engine construction, producing for each hook a frozen ordered handler list. Dispatch at runtime is an array walk — no lookup, no registration after start.

There is no `dependsOn` graph and no priority numbers; Vite shipped without them and so do we. If two plugins genuinely need ordering beyond `enforce`, the application author orders the array.

## The hook catalog

Every hook name, its kind, when it fires, its signature (abbreviated — full schemas live with the implementation plan), and a real plugin that wants it. The catalog is deliberately small; each row exists because an audit item or landed seam demands it.

| Hook | Kind | Fires |
| --- | --- | --- |
| `config` | waterfall | once, before config resolution |
| `configResolved` | parallel | once, after resolution |
| `runStart` | parallel | after a run is claimed and activated, before the flow body runs |
| `runEnd` | parallel | after a run reaches a terminal transition (success, failure, cancelled, continued) |
| `runControl` | sequential | when pause / resume / cancel / hijack is requested, before the durable transition |
| `stepStart` | parallel | after attempt admission, before an activity executes |
| `stepEnd` | parallel | after `attempts.finish`, with the settled result and boundary evidence |
| `resolveRetry` | first | when a failed attempt needs a next-delay decision |
| `classifyError` | first | when a failure needs a transient/permanent classification |
| `resolveShareability` | first | when the executor must decide whether a settled result may be cached |
| `cacheInconsistency` | sequential | when `CacheStore.put` returns `Conflict` |
| `waitStart` / `wake` | parallel | when a run parks with a waiting reason / when it wakes |
| `checkpoint` | sequential | at step boundaries, when a snapshot-capable host is present |
| `journalEvent` | parallel | on the lossy telemetry channel, per journalled event |

Selected signatures and the plugin each was designed for:

**`resolveRetry`** — `(ctx: { attempt: number; error: unknown; classification: ErrorClass; activity: ActivityMeta }) => Effect<Option<RetryDecision>>` where `RetryDecision = { delayMs: number } | { giveUp: TypedFailure }`. Fires at the engine's single retry decision point; the core default is the data-shaped `RetryPolicy` (`nextDelay(policy, persistedAttempt)`, Temporal `retrypolicy.go` shape) fed by the *persisted* attempt count. Example plugin: a rate-limit-aware policy that reads a provider's `retry-after` from the error and returns it as the delay.

**`classifyError`** — `(error: unknown, ctx: StepContext) => Effect<Option<"transient" | "permanent">>`. First hook with a core default (`hardViolation` → permanent; unknown → transient). Example: a plugin that classifies HTTP 4xx from a tool call as permanent.

**`resolveShareability`** — `(ctx: { tier: Tier; boundaryMode: BoundaryMode; evidence: BoundaryEvidence }) => Effect<Option<Shareability>>` where `Shareability = { shareable: true } | { shareable: false; reason: string }`. This ports `SkyKey.valueIsShareable()`: the executor asks once and never re-derives `tier === "sealed" && boundaryMode === "hard"` inline. Example: a plugin marking results unshareable when the host reported non-hermetic reads.

**`cacheInconsistency`** — `(event: { key: string; existing: CacheRow; attempted: CacheRow }) => Effect<InconsistencyVerdict>` with `InconsistencyVerdict = "fail" | "tolerate"`; sequential, first `"fail"` wins after all handlers run (every handler always observes the event — that is why this is sequential, not first). The core default plugin (`flows-plugin-strict-cache`, installed unless replaced) journals a `cache_conflict` record and returns `"fail"`. Until the dispatcher is wired, `ActivityPersistence` applies that same strict default inline when no `Inconsistency` layer is provided (`Inconsistency.layerTolerant` opts out) — Skyframe's `THROWING` `GraphInconsistencyReceiver`. A tolerant deployment swaps in a plugin returning `"tolerate"`.

**`runControl`** — `(req: { verb: "pause" | "resume" | "cancel" | "hijack"; actor: string; reason?: string; runId: RunId }) => Effect<void, ControlRejected>`. Runs before the durable transition; a typed failure vetoes it. The attribution record itself is core (journalled with the transition); *hijack semantics* — handing the agent session to a human — is a harness plugin on this hook, exactly as the Smithers audit prescribed.

**`waitStart` / `wake`** — `(w: { runId: RunId; reason: "approval" | "event" | "timer" | "quota" | string; wakeAt?: number; token?: string }) => Effect<void>`. Observers over the waiting-reason taxonomy on `DurableEngineState`. Example: the quota-park plugin below; another: a notifier that pings a human when a run parks on `approval`.

**`checkpoint`** — `(ctx: { runId: RunId; stepKey: string; seq: number }) => Effect<void>` requiring a `Checkpoint` host capability from the plugin's own `layer`. Fires only when such a layer is present (browser hosts omit it via `makeNoop`); the engine core never snapshots inline.

**`journalEvent`** — observer over the lossy telemetry channel only. It cannot see, delay, or veto the lifecycle `emit` path — history durability is core, full stop.

### Services, not hooks

Some audit items are background *processes*, not call sites: the due-clock sweeper, the supervisor sweep over expired leases, sync followers. These plug in as `layer` contributions — a scoped repeating fiber launched when the layer builds, interrupted when the engine scope closes. No hook is involved, and browser hosts simply don't include those plugins. This is the second half of the Vite analogy: `configureServer` gives Vite plugins a live server object; our equivalent is a `Layer` over the live engine environment.

## The harness seam: extending `FlowsHooks`

The harness (agent loop, sessions, permissions, tools) is built *on top of* the engine and needs its own hooks (`agentTurnStart`, `toolCall`, `permissionAsk`, `sessionCompact`, …) without the engine knowing they exist. The mechanism is TypeScript module augmentation — the same trick Vite uses to inherit and extend Rollup's hook interface:

```ts
// in the harness repo
declare module "@smithers/plugin" {
  interface FlowsHooks {
    toolCall: SequentialHook<(ctx: ToolCallContext) => Effect<Option<ToolOverride>>>
    agentTurnStart: ParallelHook<(turn: TurnContext) => Effect<void>>
  }
}
```

Rules that make this sound:

- `FlowsHooks` is declared **open for augmentation, closed for dispatch**: the engine dispatches only the hooks it declared; the harness's dispatcher (same `@smithers/plugin` runtime, instantiated over the augmented interface) dispatches the harness hooks. One plugin object can carry both engine and harness hooks and be passed to both — the engine ignores keys it never dispatches (they are still type-checked, because augmentation added them to the interface).
- `apply: "harness"` lets a harness-only plugin be excluded when only the bare engine runs.
- The dispatcher (`Plugins.make(order-resolved list)`) is a plain service exported by `@smithers/plugin`, generic over the hook interface — the engine and the harness each hold their own instance over the same plugin array. No inheritance machinery, no re-export dance.

## Typed error codes

All plugin-system failures are `PluginError extends Schema.TaggedError` with a closed `code` union:

| code | when |
| --- | --- |
| `duplicate_name` | two plugins share a `name` at resolution |
| `unknown_hook` | a dynamically built plugin carries an undeclared hook key |
| `config_invalid` | the post-waterfall config fails schema decoding |
| `hook_failed` | a sequential/first/waterfall handler failed; carries `plugin`, `hook`, and the cause |
| `layer_failed` | a plugin's layer failed to build |

Parallel observer failures do not become `PluginError` failures of the run; they are journalled on the telemetry channel with the same shape.

## Example third-party plugin

The quota-park plugin from the Smithers audit, end to end — it parks a run when a provider quota is exhausted and wakes it on a durable clock:

```ts
import { Effect, Option, Schedule } from "effect"
import type { FlowsPlugin } from "@smithers/plugin"

export const quotaPark = (opts: { readonly wakeSlackMs?: number } = {}): FlowsPlugin => ({
  name: "flows-plugin-quota-park",
  hooks: {
    // Decision: quota errors are transient, with a provider-supplied horizon.
    classifyError: (error) =>
      Effect.succeed(isQuotaError(error) ? Option.some("transient" as const) : Option.none()),
    // Decision: instead of hot-retrying, hand back a delay at the quota horizon.
    resolveRetry: ({ error }) =>
      Effect.succeed(
        isQuotaError(error)
          ? Option.some({ delayMs: error.resetAtMs - error.nowMs + (opts.wakeSlackMs ?? 5_000) })
          : Option.none()
      ),
    // Observation: record the park reason so operators see "quota", not a generic timer.
    waitStart: (w) =>
      w.reason === "quota" ? Effect.log(`run ${w.runId} quota-parked until ${w.wakeAt}`) : Effect.void,
  },
})
```

Nothing here edits the engine: the classification, the delay, and the taxonomy entry all flow through hooks; the durable wake itself rides the existing `DurableClock` machinery.

## What is NOT a hook

The core stays small by refusing hooks where correctness lives:

- **Journal admission, sequence allocation, and write fencing.** No plugin sees a lifecycle event before it is durable, and none can write to the canonical stream. Only the lossy telemetry channel is observable.
- **Ownership: claim, heartbeat, fence checks, steal.** `RunStore` CAS semantics are not policy.
- **Step-key construction and hashing.** Content addressing is the engine's identity; a pluggable key function would silently fork the cache universe.
- **Cache get/put mechanics.** Plugins decide *shareability* and *conflict response*; they never intercept reads or rewrite rows.
- **Capability grants.** The kernel's permission decisions are a security boundary, not an extension point. (A harness *UI* for attended grants is harness code consuming kernel services, not a hook.)
- **Flow-body transformation.** There is no `transform`; flows are code.
- **Scheduling and fiber supervision.** Concurrency is Effect's job.

If a future feature seems to need one of these as a hook, the answer is a new *narrow* hook at a decision point, or a service contributed by `layer` — never a general interceptor.

## Relationship to existing seams

- `packages/engine-store` `ActivityPersistence` gains exactly three call sites (`resolveShareability`, `cacheInconsistency`, `classifyError`/`resolveRetry` at its failure path) and loses its inline predicates.
- `packages/engine` `FlowEngine` gains `runStart`/`runEnd`/`runControl`/`waitStart`/`wake` dispatch around transitions it already performs.
- `packages/journal` is untouched except that the telemetry channel feeds `journalEvent`.
- `packages/flows` (the barrel) re-exports `@smithers/plugin`.

See [implementation status](implementation-status.md) for what is landed; this spec is listed there under planned work until the implementation plan closes it.
