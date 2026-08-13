# @smthrs/platform-node-next

The Node.js Host bundle for `flows`.

`@effect/platform-node` already ships `FileSystem`, `Path`,
`ChildProcessSpawner`, and an Undici-backed `HttpClient`. This package adds no
implementation of its own: it composes the complete closed five-tag Host
surface, including the Node `Jj` adapter from `@smthrs/jj-next`.

```ts
import { NodeHost } from "@smthrs/platform-node-next"
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

There is no HTTP service either. An outgoing request is Effect's `HttpClient`,
and the bundle provides `NodeHttpClient.layerUndici`. Undici installs no
redirect interceptor, so every hop stays a separate, checkable request.

Wrap the bundle in `@smthrs/kernel-next`'s `HostServices.layer` to get the
permission-aware projection, where `proc:spawn` is checked against the rendered
command line before any process starts and `net:get` / `net:post` is checked
against the host of every URL — including each redirect hop.

## Modules

| Module     | What it provides                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `NodeHost` | The complete closed Host bundle, plus `layer`; re-exports Effect's `NodeFileSystem`, spawner, and `HttpClient` |

**Node-only by construction.** The bundle resolves `node:child_process` and
friends; `scripts/browser-check.mjs` at the repository root pins that.
