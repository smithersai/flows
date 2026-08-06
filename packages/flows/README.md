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

## The barrel is a Node entry point

`@smithers/flows` re-exports `@smithers/engine-store`, which is Node-only
(`process.pid` and `node:crypto`, issue #114), so **the barrel does not bundle
for a browser**. Browser consumers import the per-package roots, each of which
is gated by `npm run browser`: `@smithers/host`, `@smithers/host/browser/BrowserHost`,
`@smithers/kernel`, `@smithers/keys`, `@smithers/database`, `@smithers/journal`,
`@smithers/engine`, `@smithers/plugin`, `@smithers/sync`, and
`@smithers/time-travel`.

Platform implementations are never re-exported through the namespaces here
either — `Host.NodeHost` does not exist. Import
`@smithers/host/node/NodeHost`, `@smithers/host/test/TestHost`,
`@smithers/database/node/NodeDatabase`, or `@smithers/journal/test/TestJournal`
directly. See [browser support](../../docs/architecture/browser-support.md).

Declaration merging for `Plugin.FlowsHooks` must target its owning module,
`declare module "@smithers/plugin"`; the barrel is not an augmentation target.

See the [documentation index](../../docs/README.md) and
[flows reference](../../docs/reference/flows.md).
