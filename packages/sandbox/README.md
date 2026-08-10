# @smthrs/sandbox

Provider-neutral remote sandbox execution and liveness for flows. Provider
packages adapt their SDK sessions to `RemoteSandbox.Provider`; this package owns
the conversion to `@smthrs/host`'s closed `ShellError` surface and the sandbox
health taxonomy.

```sh
npm install @smthrs/sandbox
```

## Public API

| Namespace       | Public exports                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RemoteSandbox` | `ProviderError`, the `Provider` interface/tag, and `layerShell`; scripted-test models `TestScript`, `TestSandboxState`, `TestSandboxProvider`, and `TestSandbox.make`. |
| `SandboxHealth` | `HealthState` (`Healthy` / `Unhealthy`), `UnhealthyReason`, `PingProvider`, deadline-bounded `probe`, the service tag, and `make`, `makeNoop`, `layer`, `layerNoop`.   |

Opening a provider is scoped, so interruption closes the layer scope and runs
the provider's cancellation finalizer. No `AbortSignal` crosses this seam.

The package is browser-bundleable: it adapts a provider a caller hands it and
owns no host access of its own. `npm run browser` at the repository root pins
that property.

```ts
import { Shell } from "@smthrs/host"
import { RemoteSandbox } from "@smthrs/sandbox"
import { Effect } from "effect"

const provider = RemoteSandbox.TestSandbox.make({
  scripts: { "echo hi": { result: { stdout: "hi", stderr: "", exitCode: 0 } } }
})

const program = Effect.gen(function*() {
  const shell = yield* Shell.Shell
  return yield* shell.exec("echo hi")
}).pipe(Effect.provide(RemoteSandbox.layerShell(provider)))

Effect.runPromise(program)
```

See the [host reference](../../docs/reference/host.md).
