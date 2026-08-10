# @smthrs/platform-bun

The Bun Host bundle for `flows`.

`@effect/platform-bun` re-exports the `@effect/platform-node` filesystem and
child-process spawner unchanged, so this package adds only the fetch-backed
single-hop `BunHttpTransport` and composes the complete closed six-tag Host
surface, including the Bun `Pty` and `Jj` adapters from `@smthrs/pty` and
`@smthrs/jj`.

```ts
import { BunHost } from "@smthrs/platform-bun"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("git", ["status", "--short"]))
})

Effect.runPromise(Effect.provide(program, BunHost.layer))
```

There is no shell service. Running a command is Effect's `ChildProcess` /
`ChildProcessSpawner`; because Bun's spawner *is* the Node one, there is no
runtime detection here either — the bundle works unchanged under Node, which is
what vitest and CI run.

## Modules

| Module             | What it provides                                       |
| ------------------ | ------------------------------------------------------ |
| `BunHost`          | The complete closed Host bundle, plus `layer`          |
| `BunFileSystem`    | Bun's `FileSystem`, which is Effect's Node implementation |
| `BunHttpTransport` | Single-hop `HttpTransport` over the global `fetch`     |

**Node-only by construction.** The bundle falls back to the
`@effect/platform-node` adapters off Bun and resolves `node:` built-ins;
`scripts/browser-check.mjs` at the repository root pins that.
