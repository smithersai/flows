# @smthrs/flows-next

Convenience barrel for the complete durable flows architecture. Each package
is re-exported as a namespace so consumers can opt into one dependency
without flattening neighboring service constructors; `namespaces` lists those
runtime namespace names.

```sh
npm install @smthrs/flows-next
```

```ts
import { Engine, EngineStore, Journal, Kernel } from "@smthrs/flows-next"
```

## Public API

| Namespace                                                                                                         | Re-exported package                                        |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Canonical`                                                                                                       | `@smthrs/canonical-next`                                   |
| `Capability`                                                                                                      | `@smthrs/capability-next`                                  |
| `Crypto`                                                                                                          | `@smthrs/crypto-next`                                      |
| `Database`                                                                                                        | `@smthrs/database-next`                                    |
| `Engine`                                                                                                          | `@smthrs/engine-next`                                      |
| `Flow`, `Action`, `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, `FlowRuntime`, `StepIdentity` | `@smthrs/flow-next` (re-exported flat)                     |
| `EngineStore`                                                                                                     | `@smthrs/engine-store-next`                                |
| `Jj`                                                                                                              | `@smthrs/jj-next`                                          |
| `Journal`                                                                                                         | `@smthrs/journal-next`                                     |
| `RunStore`                                                                                                        | `@smthrs/run-store-next`                                   |
| `StepCache`                                                                                                       | `@smthrs/step-cache-next`                                  |
| `Kernel`                                                                                                          | `@smthrs/kernel-next`                                      |
| `Keys`                                                                                                            | `@smthrs/keys-next`                                        |
| `Sandbox`                                                                                                         | `@smthrs/sandbox-next`                                     |
| `Sync`                                                                                                            | `@smthrs/sync-next`                                        |
| `TimeTravel`                                                                                                      | `@smthrs/time-travel-next` (service key, re-exported flat) |

Namespacing preserves APIs such as `Kernel.ChildProcessSpawner.layerNoop` and
`RunStore.RunStore.layer`. Depend on an individual package when a narrower
dependency surface is preferable.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle
is chosen by the program that runs, not by the library it depends on.

## The barrel is a browser entry point

`@smthrs/flows-next` bundles for a browser, and `npm run browser` gates it along
with every package root it re-exports: `@smthrs/canonical-next`,
`@smthrs/capability-next`, `@smthrs/crypto-next`, `@smthrs/jj-next`,
`@smthrs/jj-next/browser/BrowserJj`, `@smthrs/platform-browser-next`,
`@smthrs/platform-browser-next/BrowserHost`, `@smthrs/sandbox-next`, `@smthrs/kernel-next`,
`@smthrs/keys-next`, `@smthrs/database-next`, `@smthrs/journal-next`, `@smthrs/run-store-next`,
`@smthrs/step-cache-next`, `@smthrs/flow-next`, `@smthrs/engine-next`,
`@smthrs/engine-store-next`, `@smthrs/sync-next`, and `@smthrs/time-travel-next`.

Bundling is a weaker claim than running. The durable composition still needs a
SQL client behind the `DurableWriter` contract, and the only ones shipped here
are `node:sqlite`-backed, so a browser deployment must supply its own.

Platform implementations are never re-exported through the namespaces here
either. Import `@smthrs/platform-node-next`, `@smthrs/platform-bun-next`,
`@smthrs/kernel-next/test/TestHost`, `@smthrs/database-next/node/NodeDatabase`, or
`@smthrs/journal-next/test/TestJournal` directly. See [browser support](../../docs/architecture/browser-support.md).

See the [documentation index](../../docs/README.md) and
[flows reference](../../docs/reference/flows.md).
