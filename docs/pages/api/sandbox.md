# @smthrs/sandbox

Provider-neutral remote process execution and sandbox liveness. Provider packages adapt their SDK sessions to `RemoteSandbox.Provider`; this package converts them onto `@smthrs/host`'s closed `ShellError` surface and adds the health taxonomy above it.

```ts
import { Shell } from "@smthrs/host"
import { RemoteSandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"

const provider = RemoteSandbox.TestSandbox.make({
  scripts: { "echo hi": { result: { stdout: "hi", stderr: "", exitCode: 0 } } }
})

const program = Effect.gen(function*() {
  const shell = yield* Shell.Shell
  return yield* shell.exec("echo hi")
}).pipe(Effect.provide(RemoteSandbox.layerShell(provider)))
```

The package depends on `@smthrs/host` and nothing else in the workspace: a sandbox is one way to satisfy `Shell`, so it sits above the host contract rather than inside it. It bundles for the browser — it only runs the effect a provider hands it.

## Entry points

| Import | Source |
| --- | --- |
| `@smthrs/sandbox` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/sandbox/src/index.ts) |
| `@smthrs/sandbox/RemoteSandbox` | [src/RemoteSandbox.ts](https://github.com/smithersai/flows/blob/main/packages/sandbox/src/RemoteSandbox.ts) |
| `@smthrs/sandbox/SandboxHealth` | [src/SandboxHealth.ts](https://github.com/smithersai/flows/blob/main/packages/sandbox/src/SandboxHealth.ts) |

## RemoteSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `ProviderError` | class | tagged `flows/host/RemoteSandbox/ProviderError`; reuses the closed `ShellErrorCode` |
| `Provider` | interface + service tag | `session`, scoped `open`, `exec`, `execStream` |
| `layerShell` | layer | a `Shell` backed by a provider; acquisition is tied to the layer scope |
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

[`@smthrs/host`](host.md) owns the `Shell` contract this adapts to, and [`@smthrs/journal`](journal.md) owns the run-ownership heartbeat that detects a dead engine owner rather than a dead sandbox.
