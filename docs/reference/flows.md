# `@smithers/flows`

The barrel package. It has no API of its own — it re-exports every engine
package as a namespace so one dependency yields the whole engine surface.

```ts
import { Engine, Host, Journal } from "@smithers/flows"
```

| Namespace     | Package                  | Reference                              |
| ------------- | ------------------------ | -------------------------------------- |
| `Database`    | `@smithers/database`     | [database](database.md)                |
| `Engine`      | `@smithers/engine`       | [engine](engine.md)                    |
| `EngineStore` | `@smithers/engine-store` | [engine-store](engine-store.md)        |
| `Host`        | `@smithers/host`         | [host](host.md)                        |
| `Journal`     | `@smithers/journal`      | [journal](journal.md)                  |
| `Kernel`      | `@smithers/kernel`       | [kernel](kernel.md)                    |
| `Keys`        | `@smithers/keys`         | [keys](keys.md)                        |
| `Sync`        | `@smithers/sync`         | [sync](sync.md)                        |
| `TimeTravel`  | `@smithers/time-travel`  | [time-travel](time-travel.md)          |

Each package is exported as a namespace rather than flattened, so every
package keeps its own `make` / `makeNoop` / `layerNoop` trio without colliding
with its neighbours: `Host.Shell.layerNoop`, `Journal.Store.layer`.

## When not to use it

Depend on the individual `@smithers/*` packages when you want a narrower
dependency footprint, or when a runtime target cannot carry every engine
package. The barrel pulls in all nine.

The barrel deliberately excludes the agent-layer packages, which sit above the
engine, and the platform host adapters `@smithers/host-cloudflare` and
`@smithers/host-vercel`, which are vendor integrations living in the
[plugins repository](https://github.com/smithersai/plugins).

See the [package map](../architecture/package-map.md) for the dependency
direction between the packages this barrel re-exports.
