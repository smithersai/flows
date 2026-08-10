# @smthrs/plugin

Typed, Effect-native plugin kernel for flows. It owns the hook catalog,
Vite-style plugin resolution and ordering, config resolution, dispatch service,
and startup kernel used by higher architectural layers.

```sh
npm install @smthrs/plugin
```

## Public API

`FlowsHooks` and the Hooks, Plugin, and PluginError members are flat root
exports. The remaining modules are namespaced; every source module is also
available from its matching `@smthrs/plugin/*` subpath.

| Export               | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FlowsHooks`         | Augmentable interface defining `config`, `configResolved`, run/step lifecycle, retry, shareability, inconsistency, wait, checkpoint, and journal hooks. It must be augmented through `declare module "@smthrs/plugin"`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Hooks (flat)         | Dispatch types `HookKind`, `HookMeta`, `HookObject`, `HookEntry`, `SequentialHook`, `ParallelHook`, `FirstHook`, and `WaterfallHook`; utilities `KindOf`, `HandlerOf`, `KeysOfKind`, `ArgsOf`, `ReturnOf`, `SuccessOf`, and `ContextOf`; models `RunId`, `ErrorClass`, `RetryDecision`, `Shareability`, `InconsistencyVerdict`, `ActivityMeta`, `StepContext`, `RunContext`, `RunEndContext`, `StepEndContext`, `ControlRequest`, `ControlRejected`, `WaitContext`, `CacheRow`, `InconsistencyEvent`, `RetryContext`, `ShareabilityContext`, `CheckpointContext`, and `TelemetryEvent`; runtime `engineHooks`, `handlerOf`, and `orderOf`. |
| Plugin (flat)        | `Apply`, `FlowsPlugin`, `PluginInput`, and identity constructor `make`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Plugin errors (flat) | `PluginErrorCode` schema/type and `PluginError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Config`             | Schema/type pairs `RetryConfig`, `EngineConfig`, `FlowsConfig`, and `ResolvedConfig`; `defaults`, `merge`, `resolve`, and `deepFreeze`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Kernel`             | `Kernel` result model, `runConfig`, and `make(plugins, config, options)` resolve config and merge plugin layers. `options.cacheEnvironment` supplies complete capability and additional semantic layer/configuration identity for cross-run sealed reuse.                                                                                                                                                                                                                                                                                                                                                                                  |
| `Plugins`            | `Service` / `Plugins` dispatch `sequential`, `parallel`, `first`, and `waterfall` hooks; `make`, `makeNoop`, `layer`, and `layerNoop`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Resolve`            | `HandlerRecord`, `Resolved`, and `Options`; `resolve` flattens, filters, validates, orders, and freezes plugins; `layer` merges resolved plugin layers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

```ts
import { type FlowsPlugin, Kernel } from "@smthrs/plugin"
import { Effect } from "effect"

const telemetry: FlowsPlugin = {
  name: "flows-plugin-telemetry",
  hooks: { runStart: ({ runId }) => Effect.log(`started ${runId}`) }
}

const program = Effect.gen(function*() {
  const kernel = yield* Kernel.make([telemetry], {})
  yield* kernel.plugins.parallel("runStart", { runId: "run-1" })
})
```

See the [plugin architecture](../../docs/architecture/plugin-system.md).
