# @smthrs/flows

The umbrella barrel. It re-exports the sixteen engine packages as namespaces, so one dependency gives you the whole surface without collapsing each package's `make` / `makeNoop` / `layerNoop` trio into a shared namespace.

```ts
import { Engine, Host, Journal } from "@smthrs/flows"
import * as Schema from "effect/Schema"

const shell = Host.Shell.layerNoop({})
const runs = Journal.RunStore.layer
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
| `EngineStore` | `@smthrs/engine-store` | [EngineStore](/api/engine-store) |
| `Host` | `@smthrs/host` | [Host](/api/host) |
| `Jj` | `@smthrs/jj` | [Jj](/api/jj) |
| `Journal` | `@smthrs/journal` | [Journal](/api/journal) |
| `Kernel` | `@smthrs/kernel` | [Kernel](/api/kernel) |
| `Keys` | `@smthrs/keys` | [Keys](/api/keys) |
| `PlatformBrowser` | `@smthrs/platform-browser` | [PlatformBrowser](/api/platform-browser) |
| `Plugin` | `@smthrs/plugin` | [Plugin](/api/plugin) |
| `Sandbox` | `@smthrs/sandbox` | [Sandbox](/api/sandbox) |
| `Sync` | `@smthrs/sync` | [Sync](/api/sync) |
| `TimeTravel` | `@smthrs/time-travel` | [TimeTravel](/api/time-travel) |

## Own exports

| Export | Kind | Notes |
| --- | --- | --- |
| `namespaces` | const | the namespace names above, in export order |

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
