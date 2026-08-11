# `@smthrs/flows`

The barrel package. It re-exports every engine package as a namespace so one
dependency yields the whole engine surface. Its only API of its own is
`namespaces`, the runtime list of the re-exported namespace names — also the
barrel's one executable statement, so the package's 100% coverage gate has a
real denominator instead of an empty one (issue #169).

```ts
import { Engine, Host, Journal } from "@smthrs/flows"
```

| Namespace     | Package                  | Reference                              |
| ------------- | ------------------------ | -------------------------------------- |
| `Canonical`   | `@smthrs/canonical`     | [canonical](canonical.md)              |
| `Crypto`      | `@smthrs/crypto`        | [crypto](crypto.md)                    |
| `Database`    | `@smthrs/database`     | [database](database.md)                |
| `Engine`      | `@smthrs/engine`       | [engine](engine.md)                    |
| `EngineStore` | `@smthrs/engine-store` | [engine-store](engine-store.md)        |
| `Jj`          | `@smthrs/jj`           | [jj](jj.md)                            |
| `Journal`     | `@smthrs/journal`      | [journal](journal.md)                  |
| `Kernel`      | `@smthrs/kernel`       | [kernel](kernel.md)                    |
| `Keys`        | `@smthrs/keys`         | [keys](keys.md)                        |
| `Plugin`      | `@smthrs/plugin`       | [plugin-system](../architecture/plugin-system.md) |
| `Sandbox`     | `@smthrs/sandbox`      | [sandbox](sandbox.md)                  |
| `Sync`        | `@smthrs/sync`         | [sync](sync.md)                        |
| `TimeTravel`  | `@smthrs/time-travel`  | [time-travel](time-travel.md)          |

Each package is exported as a namespace rather than flattened, so every
package keeps its own `make` / `makeNoop` / `layerNoop` trio without colliding
with its neighbours: `Kernel.ChildProcessSpawner.layerNoop`, `Journal.Store.layer`.

The `@smthrs/platform-*` bundles are deliberately not among them, for the same
reason `effect`'s index does not re-export `@effect/platform-node`: a platform
bundle is chosen by the program that runs, not by the library it depends on.

## When not to use it

Depend on the individual `@smthrs/*` packages when you want a narrower
dependency footprint, or when a runtime target cannot carry every engine
package. The barrel pulls in all fifteen.

**A browser is one of those targets.** The barrel re-exports
`@smthrs/engine-store`, which is Node-only, so `@smthrs/flows` is a Node
entry point and does not bundle for a browser; `npm run browser` asserts that
rather than hiding it. Browser consumers import the per-package roots listed in
[browser support](../architecture/browser-support.md). The namespaces here also
carry contracts only — `Journal.TestJournal` does not exist; it lives at
`@smthrs/journal/test/TestJournal`, and the host bundles live at
`@smthrs/platform-node`, `@smthrs/platform-bun`, and
`@smthrs/platform-browser`.

The barrel deliberately excludes the agent-layer packages, which sit above the
engine, and the vendor host adapters `@smthrs/host-cloudflare` and
`@smthrs/host-vercel`, which live in the
[plugins repository](https://github.com/smithersai/plugins).

See the [package map](../architecture/package-map.md) for the dependency
direction between the packages this barrel re-exports.
