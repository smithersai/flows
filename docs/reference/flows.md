# `@smthrs/flows-next`

The barrel package. It re-exports every engine package as a namespace so one
dependency yields the whole engine surface. Its only API of its own is
`namespaces`, the runtime list of the re-exported namespace names — also the
barrel's one executable statement, so the package's 100% coverage gate has a
real denominator instead of an empty one (issue #169).

```ts
import { Engine, Kernel, Journal } from "@smthrs/flows-next"
```

| Namespace     | Package                  | Reference                              |
| ------------- | ------------------------ | -------------------------------------- |
| `Canonical`   | `@smthrs/canonical-next`     | [canonical](canonical.md)              |
| `Capability`  | `@smthrs/capability-next`    | [capability](capability.md)            |
| `Crypto`      | `@smthrs/crypto-next`        | [crypto](crypto.md)                    |
| `Database`    | `@smthrs/database-next`     | [database](database.md)                |
| `Engine`      | `@smthrs/engine-next`       | [engine](engine.md)                    |
| `Flow`, `Activity`, `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, `FlowRuntime`, `StepIdentity` | `@smthrs/flow-next` (flat) | [flow](flow.md) |
| `EngineStore` | `@smthrs/engine-store-next` | [engine-store](engine-store.md)        |
| `Jj`          | `@smthrs/jj-next`           | [jj](jj.md)                            |
| `Journal`     | `@smthrs/journal-next`      | [journal](journal.md)                  |
| `RunStore`    | `@smthrs/run-store-next`    | [run-store](run-store.md)              |
| `StepCache`   | `@smthrs/step-cache-next`   | [step-cache](step-cache.md)            |
| `Kernel`      | `@smthrs/kernel-next`       | [kernel](kernel.md)                    |
| `Keys`        | `@smthrs/keys-next`         | [keys](keys.md)                        |
| `Sandbox`     | `@smthrs/sandbox-next`      | [sandbox](sandbox.md)                  |
| `Sync`        | `@smthrs/sync-next`         | [sync](sync.md)                        |
| `TimeTravel`  | `@smthrs/time-travel-next` (service key, flat) | [time-travel](time-travel.md) |

Each package is exported as a namespace rather than flattened, so every
package keeps its own `make` / `makeNoop` / `layerNoop` trio without colliding
with its neighbours: `Kernel.ChildProcessSpawner.layerNoop`, `RunStore.RunStore.layer`.

The `@smthrs/platform-*` bundles are deliberately not among them, for the same
reason `effect`'s index does not re-export `@effect/platform-node`: a platform
bundle is chosen by the program that runs, not by the library it depends on.

## When not to use it

Depend on the individual `@smthrs/*` packages when you want a narrower
dependency footprint, or when a runtime target cannot carry every engine
package. The barrel pulls in every one of them.

**A browser is not one of those targets.** Every package root the barrel
re-exports bundles for a browser, and `npm run browser` gates `@smthrs/flows-next`
itself alongside them — see [browser support](../architecture/browser-support.md).
Bundling is still weaker than running: the durable composition needs a SQL
client behind the `DurableWriter` contract, and the only ones shipped here are
`node:sqlite`-backed. The namespaces here also carry contracts only —
`Journal.TestJournal` does not exist; it lives at
`@smthrs/journal-next/test/TestJournal`, and the host bundles live at
`@smthrs/platform-node-next`, `@smthrs/platform-bun-next`, and
`@smthrs/platform-browser-next`.

The barrel deliberately excludes the agent-layer packages, which sit above the
engine, and the vendor host adapters `@smthrs/host-cloudflare` and
`@smthrs/host-vercel`, which live in the
[plugins repository](https://github.com/smithersai/plugins).

See the [package map](../architecture/package-map.md) for the dependency
direction between the packages this barrel re-exports.
