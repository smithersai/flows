# @smthrs/pty

A real pseudo-terminal as a portable host service. Handles are scoped: closing the scope — or interrupting the fiber that owns it — kills the process. No `AbortSignal` crosses this seam.

```ts
import { Pty } from "@smthrs/pty"
import * as NodePty from "@smthrs/pty/node/NodePty"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const program = Effect.scoped(
  Effect.gen(function*() {
    const pty = yield* Pty
    const handle = yield* pty.spawn("bash -lc 'echo hi'", { cols: 80, rows: 24 })
    return yield* Stream.runCollect(handle.attach(0))
  })
).pipe(Effect.provide(NodePty.layer))
```

The package root holds the contract, its error, and the no-op layer only, so it bundles for the browser. Implementations live under `/node`, `/bun`, and `/browser`. The package depends on `effect` alone; `@smthrs/host` depends on it, because `Pty` is still one of the six tags in the closed host list.

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/pty` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/pty/src/index.ts) | any |
| `@smthrs/pty/node/NodePty` | [src/node/NodePty.ts](https://github.com/smithersai/flows/blob/main/packages/pty/src/node/NodePty.ts) | Node |
| `@smthrs/pty/bun/BunPty` | [src/bun/BunPty.ts](https://github.com/smithersai/flows/blob/main/packages/pty/src/bun/BunPty.ts) | Bun |
| `@smthrs/pty/browser/BrowserPty` | [src/browser/BrowserPty.ts](https://github.com/smithersai/flows/blob/main/packages/pty/src/browser/BrowserPty.ts) | browser |

## Root exports

[src/Pty.ts](https://github.com/smithersai/flows/blob/main/packages/pty/src/Pty.ts) is re-exported flat from the root.

| Export | Kind | Notes |
| --- | --- | --- |
| `PtySpawnOptions` | interface | `cols`, `rows`, optional `cwd` and `env` |
| `PtyHandle` | interface | `write`, `resize`, `output`, `attach(fromCursor)`, `exitCode` |
| `Pty` | interface | scoped `spawn` |
| `Pty` | service tag | `flows/host/Pty` — frozen; it is digested into step keys |
| `PtyError` | class | tagged `flows/host/PtyError`; carries `code`, `module`, `method`, `message`, `exitCode` |
| `PtyErrorCode` | const + type | `unsupported`, `exited`, `not_found`, `unknown` |
| `ptyError` | constructor | builds an error from a code plus context |
| `make`, `makeNoop` | constructors | `makeNoop` fails `spawn` with `unsupported` |
| `layerNoop` | layer | |

`attach(fromCursor)` replays the retained buffer from an absolute output cursor and then continues live. Output ends when the child's stdio pipes close, not when the child is reaped, so `exitCode` can resolve while `output`/`attach` are still draining.

## Layers

| Export | Source | Notes |
| --- | --- | --- |
| `NodePty.layer` | `src/node/NodePty.ts` | piped-stdio child processes plus a 256 kB replay ring. **A skeleton, not a real PTY** — a true one needs a native addon, which is deliberately not a dependency yet |
| `BunPty.layer` | `src/bun/BunPty.ts` | Bun implements the same child-process API, so this *is* `NodePty.layer` |
| `BrowserPty.layerUnsupported` | `src/browser/BrowserPty.ts` | `spawn` reports `unsupported`, echoing the requested command |

## Reading next

[`@smthrs/host`](host.md) owns the closed service list, and [`@smthrs/kernel`](kernel.md) decorates `Pty` with capability checks.
