# @smthrs/platform-bun-next

The Bun Host bundle: one layer that provides all five tags in the closed host list, backed by `@effect/platform-bun`.

`@effect/platform-bun` re-exports the `@effect/platform-node` filesystem and child-process spawner unchanged and ships Effect's fetch-backed `HttpClient`, so this package adds no implementation of its own: it composes those with the Bun `Jj` adapter from [@smthrs/jj-next](/api/jj). Bun no longer depends on [@smthrs/platform-browser-next](/api/platform-browser) to reach `fetch`.

There is no shell service, and — because Bun's spawner *is* the Node one — no runtime detection either. The bundle works unchanged under Node, which is what vitest and CI run. See [design decisions](/design-decisions) for why the old `Shell` wrapper and its hand-rolled `Bun.spawn` detection were deleted together.

```ts
import { BunHost } from "@smthrs/platform-bun-next"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("printf", ["hello"]))
}).pipe(Effect.provide(BunHost.layer))
```

This entry point is Node-only by construction: it falls back to the `@effect/platform-node` adapters off Bun and resolves `node:fs`. `scripts/browser-check.mjs` pins that.

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/platform-bun-next` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/platform-bun/src/index.ts) | Bun, Node |
| `@smthrs/platform-bun-next/BunHost` | [src/BunHost.ts](https://github.com/smithersai/flows/blob/main/packages/platform-bun/src/BunHost.ts) | Bun, Node |
| `@smthrs/platform-bun-next/BunFileSystem` | [src/BunFileSystem.ts](https://github.com/smithersai/flows/blob/main/packages/platform-bun/src/BunFileSystem.ts) | Bun, Node |

## Exports

| Export | Kind | Notes |
| --- | --- | --- |
| `BunHost.BunHost` | type | `FileSystem \| Path \| ChildProcessSpawner \| Jj \| HttpClient` |
| `BunHost.layer` | layer | the complete closed host surface |
| `BunHost.implementationIds` | const | identity tokens keyed by `HostServiceIds`, digested into step keys — not import specifiers |
| `BunHost.BunChildProcessSpawner` | re-export | `@effect/platform-bun`'s spawner, which is `@effect/platform-node-shared`'s |
| `BunHost.BunHttpClient` | re-export | `@effect/platform-bun`'s fetch-backed `HttpClient`, provided with `RequestInit { redirect: "manual" }` so the kernel sees every hop |
| `BunFileSystem.layer` | layer | Effect's Node filesystem, typed as Bun's |

## Conformance

The package runs the shared suite from [`@smthrs/kernel-next/test/contract`](/api/kernel) against `BunHost.layer`. Under vitest that exercises the Node fallback, which is not a gap: process spawning is literally the same module on both runtimes, so there is no Bun-only spawn path left to fake.

## Reading next

[@smthrs/kernel-next](/api/kernel) owns the closed list and decorates these same tags with capability checks. [@smthrs/platform-node-next](/api/platform-node) and [@smthrs/platform-browser-next](/api/platform-browser) are the sibling bundles.
