# @smthrs/platform-node

The Node.js Host bundle for `flows`.

`@effect/platform-node` already ships `FileSystem`, `Path`, and
`ChildProcessSpawner`. This package adds only what `flows` defines on top of
them — the single-hop `NodeHttpTransport` — and composes the complete closed
six-tag Host surface, including the Node `Pty` and `Jj` adapters from
`@smthrs/pty` and `@smthrs/jj`.

```ts
import { NodeHost } from "@smthrs/platform-node"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, NodeHost.layer))
```

There is no shell service. Running a command is Effect's `ChildProcess` /
`ChildProcessSpawner`; a wall-clock budget is `Effect.timeout` around the
effect, and cancellation is fiber interruption, not an `AbortSignal`.

Wrap the bundle in `@smthrs/kernel`'s `HostServices.layer` to get the
permission-aware projection, where `proc:spawn` is checked against the rendered
command line before any process starts.

## Modules

| Module              | What it provides                                     |
| ------------------- | ---------------------------------------------------- |
| `NodeHost`          | The complete closed Host bundle, plus `layer`         |
| `NodeHttpTransport` | Single-hop `HttpTransport` over Undici, no redirects  |

**Node-only by construction.** The bundle resolves `node:child_process` and
friends; `scripts/browser-check.mjs` at the repository root pins that.
