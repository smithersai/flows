# @smthrs/jj

Jujutsu version control as a portable host service: `flows` snapshots the working copy around every step, so jj is host access, not a tool the agent happens to call.

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.snapshot("before the step")
}).pipe(Effect.provide(NodeJj.layer))
```

The package root holds the contract, its error, and the no-op layer only, so it bundles for the browser. Implementations live under `/node`, `/bun`, and `/browser`. The package depends on `effect` and `@smthrs/capability` (its error channel names `Permission.PermissionError`); `@smthrs/kernel` depends on it, because `Jj` is still one of the five tags in the closed host list.

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/jj` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/jj/src/index.ts) | any |
| `@smthrs/jj/node/NodeJj` | [src/node/NodeJj.ts](https://github.com/smithersai/flows/blob/main/packages/jj/src/node/NodeJj.ts) | Node |
| `@smthrs/jj/bun/BunJj` | [src/bun/BunJj.ts](https://github.com/smithersai/flows/blob/main/packages/jj/src/bun/BunJj.ts) | Bun |
| `@smthrs/jj/browser/BrowserJj` | [src/browser/BrowserJj.ts](https://github.com/smithersai/flows/blob/main/packages/jj/src/browser/BrowserJj.ts) | browser |

## Root exports

[src/Jj.ts](https://github.com/smithersai/flows/blob/main/packages/jj/src/Jj.ts) is re-exported flat from the root.

| Export | Kind | Notes |
| --- | --- | --- |
| `ChangeId` | type | string handle for workspace state |
| `Jj` | interface | `snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, `status` |
| `Jj` | service tag | `@smthrs/jj/Jj` — digested into step keys |
| `JjError` | class | tagged `@smthrs/jj/JjError`; carries `code`, `module`, `method`, `message`, `command` |
| `JjErrorCode` | const + type | `not_installed`, `conflict`, `invalid_ref`, `unknown` |
| `jjError` | constructor | builds an error from a code plus context |
| `make`, `makeNoop` | constructors | `makeNoop` fails every method `not_installed` |
| `layerNoop` | layer | |

## Layers

| Export | Source | Notes |
| --- | --- | --- |
| `NodeJj.layer` | `src/node/NodeJj.ts` | spawns the jj CLI with argv, never a shell string; classifies stderr onto the stable codes |
| `BunJj.layer` | `src/bun/BunJj.ts` | Bun implements the same child-process API, so this *is* `NodeJj.layer` |
| `BrowserJj.layerUnsupported` | `src/browser/BrowserJj.ts` | every operation reports `not_installed`, naming the jj command it would have run |

## Reading next

[`@smthrs/kernel`](kernel.md) owns the closed service list and decorates `Jj` with capability checks, and [`@smthrs/time-travel`](time-travel.md) uses it for workspace snapshot and restore.
