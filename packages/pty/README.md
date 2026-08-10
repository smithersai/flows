# @smthrs/pty

Pseudo-terminal access as a portable Effect host service. A handle is scoped:
closing the scope — or interrupting the fiber that owns it — kills the process.
No `AbortSignal` crosses this seam.

```sh
npm install @smthrs/pty
```

## Entry points

The root is **platform-neutral and browser-bundleable**: the contract, its
error, and the no-op layer only. Every implementation lives under an explicit
subpath, the way `effect` keeps `@effect/platform-node` out of `effect`, so
importing the contract never resolves a `node:` built-in.

| Import                           | Platform                                     |
| -------------------------------- | -------------------------------------------- |
| `@smthrs/pty`                    | any — contract only; bundles for the browser |
| `@smthrs/pty/browser/BrowserPty` | browser — `spawn` fails `unsupported`        |
| `@smthrs/pty/node/NodePty`       | Node (`node:child_process`)                  |
| `@smthrs/pty/bun/BunPty`         | Bun, reusing the Node adapter                |

`npm run browser` at the repository root pins that table.

## Public API

| Export                                 | Meaning                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `Pty`                                  | The service interface and its tag (`flows/host/Pty`).                   |
| `PtySpawnOptions`, `PtyHandle`         | Spawn geometry, and the scoped handle with cursor-replay `attach`.      |
| `PtyErrorCode`, `PtyError`, `ptyError` | The closed failure vocabulary and its constructor.                      |
| `make`, `makeNoop`, `layerNoop`        | Complete, stubbed, and layered service construction.                    |
| `NodePty.layer`, `BunPty.layer`        | Piped-stdio child processes plus a bounded replay ring.                 |
| `BrowserPty.layerUnsupported`          | The ticket-failing browser layer — an absent capability with an answer. |

`NodePty` is a skeleton, not a real PTY: a true pseudo-terminal needs a native
addon (`node-pty` / `@lydell/node-pty`), which is deliberately not a dependency
yet. Swapping one in means replacing `spawn`/`write`/`resize`; the contract and
the replay buffer stay as they are.

```ts
import { Pty } from "@smthrs/pty"
import * as NodePty from "@smthrs/pty/node/NodePty"
import { Effect, Stream } from "effect"

const program = Effect.scoped(
  Effect.gen(function*() {
    const pty = yield* Pty
    const handle = yield* pty.spawn("bash -lc 'echo hi'", { cols: 80, rows: 24 })
    return yield* Stream.runCollect(handle.attach(0))
  })
).pipe(Effect.provide(NodePty.layer))

Effect.runPromise(program)
```

The tag key and the error `_tag` are `flows/host/…` and are frozen: step keys
digest the resolved service set and `PtyError` round-trips through the journal,
so this package's identity strings survived its split out of `@smthrs/host`.

See the [host reference](../../docs/reference/host.md).
