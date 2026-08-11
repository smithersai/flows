# @smthrs/sandbox

Provider-neutral remote process execution and sandbox liveness. Provider packages adapt their SDK sessions to `RemoteSandbox.Provider`; this package converts them onto Effect's `ChildProcessSpawner` contract and adds the health taxonomy above it.

```ts
import { RemoteSandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

const provider = RemoteSandbox.TestSandbox.make({
  scripts: { "echo hi": { stdout: "hi" } }
})

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return yield* spawner.string(ChildProcess.make("echo", ["hi"]))
}).pipe(Effect.provide(RemoteSandbox.layer(provider)))
```

The package depends on `@smthrs/kernel` — for `CommandLine.render` alone — and nothing else in the workspace: a sandbox is one way to satisfy `ChildProcessSpawner`, so it sits above the closed host list rather than inside it. It bundles for the browser — it only runs the effect a provider hands it.

## Entry points

| Import | Source |
| --- | --- |
| `@smthrs/sandbox` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/sandbox/src/index.ts) |
| `@smthrs/sandbox/RemoteSandbox` | [src/RemoteSandbox/](https://github.com/smithersai/flows/tree/main/packages/sandbox/src/RemoteSandbox) |
| `@smthrs/sandbox/SandboxHealth` | [src/SandboxHealth/](https://github.com/smithersai/flows/tree/main/packages/sandbox/src/SandboxHealth) |

## RemoteSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `ProviderErrorCode` | const + type | `aborted`, `timeout`, `unavailable`, `spawn_error`, `unknown` — the sandbox's own closed set |
| `ProviderError` | class | tagged `flows/host/RemoteSandbox/ProviderError` |
| `Provider` | interface + service tag | `session`, scoped `open`, scoped `spawn` |
| `RemoteProcess`, `RemoteOptions` | interfaces | a started remote process (`stdout`, `stderr`, `exitCode`) and the `cwd`/`env` carried across |
| `layer` | layer | a `ChildProcessSpawner` backed by a provider; acquisition is tied to the layer scope |
| `TestScript`, `TestSandboxState`, `TestSandboxProvider` | interfaces | scripted provider fixtures |
| `TestSandbox` | const | `make(options?)` — deterministic scripted provider |

## SandboxHealth

| Export | Kind | Notes |
| --- | --- | --- |
| `Healthy`, `Unhealthy` | classes | health states; `Unhealthy.component` is `"sandbox"` |
| `HealthState` | const + type | union schema |
| `UnhealthyReason` | const + type | `unresponsive`, `ping_failed` |
| `PingProvider`, `ProbeOptions`, `Service` | interfaces | probe inputs |
| `probe` | function | one ping under a deadline (5 seconds by default); never fails |
| `SandboxHealth` | service tag | `flows/host/SandboxHealth` |
| `make`, `makeNoop` | constructors | `makeNoop` always reports `Healthy` |
| `layer`, `layerNoop` | layers | |

## Reading next

[`@smthrs/kernel`](kernel.md) owns the closed host list this satisfies a slot of — and the `proc:spawn` check written against the same rendered command line the provider receives — and [`@smthrs/journal`](journal.md) owns the run-ownership heartbeat that detects a dead engine owner rather than a dead sandbox.
