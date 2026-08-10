# @smthrs/plugin

A Vite-style plugin kernel: a typed hook catalog, resolution and ordering, and a config waterfall.

```ts
import { Kernel, make, Plugins } from "@smthrs/plugin"

const timing = make({
  name: "timing",
  hooks: {
    runStart: (ctx) => Effect.logInfo(`start ${ctx.runId}`)
  }
})
```

The kernel ships and is tested. Dispatch at the engine seams is Planned; the core call sites still use their built-in defaults.

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/plugin` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/index.ts) | any |

## FlowsHooks

Declared in [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/index.ts) so that `declare module "@smthrs/plugin"` augmentation works. An interface can only be augmented in the module that declares it, so augmenting through the `@smthrs/flows` barrel does not work.

| Hook | Kind | Signature |
| --- | --- | --- |
| `config` | waterfall | `(config: FlowsConfig) => Partial<FlowsConfig> \| void` |
| `configResolved` | parallel | `(config: ResolvedConfig) => void` |
| `runStart` | parallel | `(ctx: RunContext) => void` |
| `runEnd` | parallel | `(ctx: RunEndContext) => void` |
| `runControl` | sequential | `(request: ControlRequest) => void`; fail with `ControlRejected` to veto |
| `stepStart` | parallel | `(ctx: StepContext) => void` |
| `stepEnd` | parallel | `(ctx: StepEndContext) => void` |
| `resolveRetry` | first | `(ctx: RetryContext) => Option<RetryDecision>` |
| `classifyError` | first | `(error, ctx: StepContext) => Option<ErrorClass>` |
| `resolveShareability` | first | `(ctx: ShareabilityContext) => Option<Shareability>` |
| `cacheInconsistency` | sequential | `(event: InconsistencyEvent) => InconsistencyVerdict` |
| `waitStart` | parallel | `(wait: WaitContext) => void` |
| `wake` | parallel | `(wait: WaitContext) => void` |
| `checkpoint` | sequential | `(ctx: CheckpointContext) => void` |
| `journalEvent` | parallel | `(event: TelemetryEvent) => void` |

## Hooks

[src/Hooks.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/Hooks.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `HookKind` | type | `sequential`, `parallel`, `first`, `waterfall` |
| `SequentialHook`, `ParallelHook`, `FirstHook`, `WaterfallHook` | types | the four dispatch shapes |
| `HookMeta`, `HookObject`, `HookEntry` | types | a handler plus its `order` |
| `KindOf`, `HandlerOf`, `KeysOfKind`, `ArgsOf`, `ReturnOf`, `SuccessOf`, `ContextOf` | types | catalog derivations |
| `engineHooks` | const | the hook names the engine itself dispatches |
| `handlerOf`, `orderOf` | functions | read a handler and its order from an entry |
| `RunContext`, `RunEndContext`, `StepContext`, `StepEndContext`, `WaitContext`, `RetryContext`, `ShareabilityContext`, `CheckpointContext`, `InconsistencyEvent`, `TelemetryEvent`, `ControlRequest`, `ControlRejected`, `ActivityMeta`, `CacheRow` | interfaces | hook payloads |
| `RunId`, `ErrorClass`, `RetryDecision`, `Shareability`, `InconsistencyVerdict` | types | hook vocabularies |

## Plugin

[src/Plugin.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/Plugin.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `make` | constructor | builds a `FlowsPlugin` |
| `FlowsPlugin` | interface | `name`, optional `enforce`, `apply`, `layer`, `hooks` |
| `Apply` | type | `engine`, `harness`, or a predicate over `FlowsConfig` |
| `PluginInput` | type | a plugin, a falsy entry, or an arbitrarily nested array |

## Resolve, Kernel, Plugins

| Export | Source | Notes |
| --- | --- | --- |
| `Resolve.resolve`, `Options`, `Resolved`, `HandlerRecord` | [src/Resolve.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/Resolve.ts) | flattens input, applies `apply` filtering, orders by `enforce` then `order` |
| `Resolve.layer` | same | provides the resolved catalog |
| `Kernel.make`, `Kernel.runConfig`, `Kernel.Kernel` | [src/Kernel.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/Kernel.ts) | startup: config waterfall, then `configResolved`; accepts `options.cacheEnvironment` |
| `Plugins.Plugins`, `Service`, `make`, `makeNoop`, `layer`, `layerNoop` | [src/Plugins.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/Plugins.ts) | the dispatcher |

## Config

[src/Config.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/Config.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `FlowsConfig`, `ResolvedConfig`, `EngineConfig`, `RetryConfig` | schemas + types | decode and validate configuration shapes |
| `defaults` | const | the resolved defaults |
| `merge`, `resolve`, `deepFreeze` | functions | the waterfall pipeline |

## PluginError

[src/PluginError.ts](https://github.com/smithersai/flows/blob/main/packages/plugin/src/PluginError.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `PluginError` | class | carries a `PluginErrorCode` |
| `PluginErrorCode` | const + type | resolution and dispatch failure codes |

## Content environment

When `options.cacheEnvironment` is supplied, `Kernel.make` prepends resolved plugin identities to its layers and declares the complete result. Without it, sealed keys stay run-local.
