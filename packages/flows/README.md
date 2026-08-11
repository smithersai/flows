# @smthrs/flows

Convenience barrel for the complete durable flows architecture. Each package
is re-exported as a namespace so consumers can opt into one dependency
without flattening neighboring service constructors; `namespaces` lists those
runtime namespace names.

```sh
npm install @smthrs/flows
```

```ts
import { Engine, EngineStore, Kernel, Journal } from "@smthrs/flows"
```

## Public API

| Namespace                                                                                                           | Re-exported package               |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `Canonical`                                                                                                         | `@smthrs/canonical`               |
| `Capability`                                                                                                        | `@smthrs/capability`              |
| `Crypto`                                                                                                            | `@smthrs/crypto`                  |
| `Database`                                                                                                          | `@smthrs/database`                |
| `Engine`                                                                                                            | `@smthrs/engine`                  |
| `Flow`, `Activity`, `RetryPolicy`, `DurableDeferred`, `DurableClock`, `DurableQueue`, `FlowRuntime`, `StepIdentity` | `@smthrs/flow` (re-exported flat) |
| `EngineStore`                                                                                                       | `@smthrs/engine-store`            |
| `Jj`                                                                                                                | `@smthrs/jj`                      |
| `Journal`                                                                                                           | `@smthrs/journal`                 |
| `RunStore`                                                                                                          | `@smthrs/run-store`               |
| `StepCache`                                                                                                         | `@smthrs/step-cache`              |
| `Kernel`                                                                                                            | `@smthrs/kernel`                  |
| `Keys`                                                                                                              | `@smthrs/keys`                    |
| `Plugin`                                                                                                            | `@smthrs/plugin`                  |
| `Sandbox`                                                                                                           | `@smthrs/sandbox`                 |
| `Sync`                                                                                                              | `@smthrs/sync`                    |
| `TimeTravel`                                                                                                        | `@smthrs/time-travel`             |

Namespacing preserves APIs such as `Kernel.ChildProcessSpawner.layerNoop` and
`RunStore.RunStore.layer`. Depend on an individual package when a narrower
dependency surface is preferable.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle
is chosen by the program that runs, not by the library it depends on.

## The barrel is a Node entry point

`@smthrs/flows` re-exports `@smthrs/engine-store`, which is Node-only
(`process.pid` and `node:crypto`, issue #114), so **the barrel does not bundle
for a browser**. Browser consumers import the per-package roots, each of which
is gated by `npm run browser`: `@smthrs/canonical`, `@smthrs/capability`,
`@smthrs/crypto`, `@smthrs/jj`, `@smthrs/jj/browser/BrowserJj`,
`@smthrs/platform-browser`, `@smthrs/platform-browser/BrowserHost`,
`@smthrs/sandbox`, `@smthrs/kernel`, `@smthrs/keys`, `@smthrs/database`,
`@smthrs/journal`, `@smthrs/run-store`, `@smthrs/step-cache`, `@smthrs/flow`,
`@smthrs/engine`, `@smthrs/plugin`, `@smthrs/sync`, and
`@smthrs/time-travel`.

Platform implementations are never re-exported through the namespaces here
either. Import `@smthrs/platform-node`, `@smthrs/platform-bun`,
`@smthrs/kernel/test/TestHost`, `@smthrs/database/node/NodeDatabase`, or
`@smthrs/journal/test/TestJournal` directly. See [browser support](../../docs/architecture/browser-support.md).

Declaration merging for `Plugin.FlowsHooks` must target its owning module,
`declare module "@smthrs/plugin"`; the barrel is not an augmentation target.

See the [documentation index](../../docs/README.md) and
[flows reference](../../docs/reference/flows.md).
