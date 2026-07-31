# @smithers/flows

`@smithers/flows` is the barrel package for the durable flow engine. It has no
API of its own: it re-exports every engine package as a namespace so a single
dependency gives you the whole surface.

```ts
import { Engine, Host, Journal } from "@smithers/flows"
```

| Namespace     | Package                  |
| ------------- | ------------------------ |
| `Database`    | `@smithers/database`     |
| `Engine`      | `@smithers/engine`       |
| `EngineStore` | `@smithers/engine-store` |
| `Host`        | `@smithers/host`         |
| `Journal`     | `@smithers/journal`      |
| `Kernel`      | `@smithers/kernel`       |
| `Keys`        | `@smithers/keys`         |
| `Sync`        | `@smithers/sync`         |
| `TimeTravel`  | `@smithers/time-travel`  |

Namespacing keeps each package's `make` / `makeNoop` / `layerNoop` trio distinct
rather than collapsing neighbours into one flat namespace, so you write
`Host.Shell.layerNoop` and `Journal.Store.layer`.

Depend on the individual `@smithers/*` packages instead when you want a narrower
dependency footprint. This barrel is a convenience, not a new seam — it must
never grow logic, and it deliberately does not re-export the agent-layer
packages, which sit above the engine.

Platform host adapters (`@smithers/host-cloudflare`, `@smithers/host-vercel`)
are vendor integrations and live in the
[plugins repository](https://github.com/smithersai/plugins); they are not part
of this barrel.

See the [documentation index](../../docs/README.md) for per-package references.
