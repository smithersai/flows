# `@smthrs/sandbox`

This page is the public API reference for remote sandbox execution and sandbox liveness. Provider packages adapt their SDK sessions to `RemoteSandbox.Provider`; this package owns the conversion onto Effect's `ChildProcessSpawner` contract and its `PlatformError` surface, plus the health taxonomy above it.

It depends on `@smthrs/kernel` — for `CommandLine.render` alone — and nothing else in the workspace. That direction is deliberate: a sandbox is one way to satisfy `ChildProcessSpawner`, so it sits above the closed host list rather than inside it.

## RemoteSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Provider` | interface + service tag | `session`, scoped `open`, and a scoped `spawn` returning a `RemoteProcess` |
| `RemoteProcess`, `RemoteOptions` | interfaces | a started remote process in the same three pieces a child process has (`stdout`, `stderr`, `exitCode`), and the `cwd`/`env` a rendered command carries across |
| `ProviderErrorCode` | const + type | `aborted`, `timeout`, `unavailable`, `spawn_error`, `unknown` |
| `ProviderError` | class | tagged `flows/host/RemoteSandbox/ProviderError` |
| `layer` | layer | adapts a configured provider to Effect's `ChildProcessSpawner` |
| `TestScript`, `TestSandboxState`, `TestSandboxProvider` | interfaces | scripted provider fixtures |
| `TestSandbox` | const | `make(options?)` builds a deterministic scripted provider |

Provider acquisition is tied to the layer scope: interrupting an execution or a stream consumer closes that scope and therefore runs the finalizer installed by `Provider.open`. No `AbortSignal` crosses this seam.

A provider may add SDK details to `ProviderError.cause`, but it cannot create new host-visible failure kinds — the code set is closed, and `layer` normalizes each code onto the `PlatformError` reason that already means it (`timeout` → `TimedOut`, `unavailable` → `NotFound`, the rest → `Unknown`), naming the `RemoteSandbox` module.

The codes are the sandbox's own. They used to borrow the deleted `Shell` service's set; a remote session goes wrong in its own ways, so the seam now declares them.

The command reaches the provider as the string `CommandLine.render` produces — the same string `@smthrs/kernel`'s `proc:spawn` check is written against, so a grant and the thing it authorizes cannot drift apart. Two capabilities a remote session does not have are declared rather than dropped: piping `stdin` and delivering a signal to `kill` both fail with a `BadArgument` `PlatformError`. A remote process ends by closing its scope.

## SandboxHealth

| Export | Kind | Notes |
| --- | --- | --- |
| `Healthy`, `Unhealthy` | classes | tagged `flows/host/SandboxHealth/Healthy` and `…/Unhealthy` |
| `HealthState` | const + type | union schema of the two |
| `UnhealthyReason` | const + type | `unresponsive`, `ping_failed` |
| `PingProvider`, `ProbeOptions`, `Service` | interfaces | probe inputs and the service shape |
| `probe` | function | runs one ping under a deadline; never fails |
| `SandboxHealth` | service tag | tag key `flows/host/SandboxHealth` |
| `make`, `makeNoop`, `layer`, `layerNoop` | constructors and layers | `makeNoop` always reports `Healthy`, for hosts without a remote sandbox |

The journal's run-ownership heartbeat detects a dead engine owner; nothing detected a dead sandbox under a live engine. This module closes that gap with a taxonomy plus a probe, not a supervisor — no polling loop lives here.

`probe` never fails: a failed ping becomes `Unhealthy(reason: "ping_failed")`, and a ping that outlives the deadline (5 seconds by default) becomes `Unhealthy(reason: "unresponsive")`. That is what distinguishes "sandbox dead" from "slow command" — the probe answers within the deadline either way. `Unhealthy.component` is `"sandbox"`, so an "engine alive, sandbox dead" diagnosis is explicit rather than inferred from a generic provider error.

Reasons, like the host error codes, are a stable public contract: never repurpose one, add one.

## Browser support

`@smthrs/sandbox` is gated as a browser entry point by `scripts/browser-check.mjs` (`npm run browser`, and one CI step). The probe only runs the effect a provider hands it, and host access stays behind the provider layer.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smthrs/kernel` reference](kernel.md), and [failure and retry](../concepts/failure-and-retry.md).
