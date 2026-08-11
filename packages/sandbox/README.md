# @smthrs/sandbox

Provider-neutral remote sandbox execution and liveness for flows. Provider
packages adapt their SDK sessions to `RemoteSandbox.Provider`; this package owns
the conversion to Effect's `ChildProcessSpawner` contract and the sandbox
health taxonomy.

```sh
npm install @smthrs/sandbox
```

## Public API

| Namespace       | Public exports                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RemoteSandbox` | `ProviderErrorCode` and `ProviderError`, the `Provider` interface/tag with `RemoteProcess`/`RemoteOptions`, and `layer`; scripted-test models `TestScript`, `TestSandboxState`, `TestSandboxProvider`, and `TestSandbox.make`. |
| `SandboxHealth` | `HealthState` (`Healthy` / `Unhealthy`), `UnhealthyReason`, `PingProvider`, deadline-bounded `probe`, the service tag, and `make`, `makeNoop`, `layer`, `layerNoop`.                                                           |

Opening a provider is scoped, so interruption closes the layer scope and runs
the provider's cancellation finalizer. No `AbortSignal` crosses this seam.

The package is browser-bundleable: it adapts a provider a caller hands it and
owns no host access of its own. `npm run browser` at the repository root pins
that property.

```ts
import { RemoteSandbox } from "@smthrs/sandbox"
import { Effect } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteSandbox.TestSandbox.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteSandbox.layer(provider)))

Effect.runPromise(program)
```

See the [sandbox reference](../../docs/reference/sandbox.md) and the
[kernel reference](../../docs/reference/kernel.md).
