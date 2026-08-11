# @smthrs/flows

The umbrella barrel. It re-exports the engine packages as namespaces, so one dependency gives you the whole surface without collapsing each package's `make` / `makeNoop` / `layerNoop` trio into a shared namespace. `@smthrs/flow` is the one exception: the authoring model is re-exported flat, so `Flow`, `Activity`, and their siblings sit at the top level.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason `effect`'s index does not re-export `@effect/platform-node`: a platform bundle is chosen by the program that runs, not by the library it depends on. Import [`@smthrs/platform-node`](/api/platform-node), [`@smthrs/platform-bun`](/api/platform-bun), or [`@smthrs/platform-browser`](/api/platform-browser) directly.

```ts
import { Engine, Kernel, RunStore } from "@smthrs/flows"
import * as Schema from "effect/Schema"

const jj = Kernel.Jj.layerNoop({})
const runs = RunStore.RunStore.layer
const Build = Engine.Flow.make("example/Build", {
  payload: { target: Schema.String },
  success: Schema.String
})
```

This entry point is Node-only, because it re-exports `@smthrs/engine-store`. Browser consumers import the per-package roots.

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/flows` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/flows/src/index.ts) | Node |

## Namespaces

| Namespace | Package | Reference |
| --- | --- | --- |
| `Canonical` | `@smthrs/canonical` | [Canonical](/api/canonical) |
| `Crypto` | `@smthrs/crypto` | [Crypto](/api/crypto) |
| `Database` | `@smthrs/database` | [Database](/api/database) |
| `Engine` | `@smthrs/engine` | [Engine](/api/engine) |
| `Activity`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`, `FlowRuntime`, `RetryPolicy`, `StepIdentity` | `@smthrs/flow` (re-exported flat) | [Flow](/api/flow) |
| `EngineStore` | `@smthrs/engine-store` | [EngineStore](/api/engine-store) |
| `Jj` | `@smthrs/jj` | [Jj](/api/jj) |
| `Journal` | `@smthrs/journal` | [Journal](/api/journal) |
| `RunStore` | `@smthrs/run-store` | [RunStore](/api/run-store) |
| `StepCache` | `@smthrs/step-cache` | [StepCache](/api/step-cache) |
| `Kernel` | `@smthrs/kernel` | [Kernel](/api/kernel) |
| `Keys` | `@smthrs/keys` | [Keys](/api/keys) |
| `Plugin` | `@smthrs/plugin` | [Plugin](/api/plugin) |
| `Sandbox` | `@smthrs/sandbox` | [Sandbox](/api/sandbox) |
| `Sync` | `@smthrs/sync` | [Sync](/api/sync) |
| `TimeTravel` | `@smthrs/time-travel` | [TimeTravel](/api/time-travel) |

## Own exports

| Export | Kind | Notes |
| --- | --- | --- |
| `namespaces` | const | the namespace names above, sorted |

`namespaces` is the barrel's one runtime value. A pure re-export module carries no executable statements, so the package's 100% coverage gate had an empty denominator and could never go red. This constant gives the gate a real denominator, and the barrel test pins it against the derived `packages/*` universe so it cannot drift from the re-exports.

## When to use the barrel

Take the barrel when you want the whole engine in one dependency and you are on Node. Take the individual packages when you want a narrower dependency footprint, or when you are targeting a browser bundle.

## Declaration merging

`Plugin` is re-exported as a namespace, and a re-export is not an augmentation target. Augment the owning module:

```ts
declare module "@smthrs/plugin" {
  interface FlowsHooks {
    toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
  }
}
```

Writing `declare module "@smthrs/flows"` compiles and then does nothing.
