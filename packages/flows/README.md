# @smithers/flows

Convenience barrel for the complete durable flows architecture. It adds no
runtime API; each package is re-exported as a namespace so consumers can opt
into one dependency without flattening neighboring service constructors.

```sh
npm install @smithers/flows
```

```ts
import { Engine, EngineStore, Host, Journal } from "@smithers/flows"
```

## Public API

| Namespace     | Re-exported package      |
| ------------- | ------------------------ |
| `Database`    | `@smithers/database`     |
| `Engine`      | `@smithers/engine`       |
| `EngineStore` | `@smithers/engine-store` |
| `Host`        | `@smithers/host`         |
| `Journal`     | `@smithers/journal`      |
| `Kernel`      | `@smithers/kernel`       |
| `Keys`        | `@smithers/keys`         |
| `Plugin`      | `@smithers/plugin`       |
| `Sync`        | `@smithers/sync`         |
| `TimeTravel`  | `@smithers/time-travel`  |

Namespacing preserves APIs such as `Host.Shell.layerNoop` and
`Journal.RunStore.layer`. Depend on an individual package when a narrower
dependency surface is preferable.

Declaration merging for `Plugin.FlowsHooks` must target its owning module,
`declare module "@smithers/plugin"`; the barrel is not an augmentation target.

See the [documentation index](../../docs/README.md) and
[flows reference](../../docs/reference/flows.md).
