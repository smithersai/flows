# `@smthrs/sandbox`

This page is the public API reference for remote sandbox execution and sandbox liveness. Provider packages adapt their SDK sessions to `RemoteSandbox.Provider`; this package owns the conversion onto `@smthrs/host`'s closed `ShellError` surface and the health taxonomy above it.

It depends on `@smthrs/host` and nothing else in the workspace. That direction is deliberate: a sandbox is one way to satisfy `Shell`, so it sits above the host contract rather than inside it.

## RemoteSandbox

| Export | Kind | Notes |
| --- | --- | --- |
| `Provider` | interface + service tag | `session`, scoped `open`, `exec`, `execStream` |
| `ProviderError` | class | tagged `flows/host/RemoteSandbox/ProviderError`; reuses the closed `ShellErrorCode` schema |
| `layerShell` | layer | adapts a configured provider to the standard `Shell` service |
| `TestScript`, `TestSandboxState`, `TestSandboxProvider` | interfaces | scripted provider fixtures |
| `TestSandbox` | const | `make(options?)` builds a deterministic scripted provider |

Provider acquisition is tied to the layer scope: interrupting an execution or a stream consumer closes that scope and therefore runs the finalizer installed by `Provider.open`. No `AbortSignal` crosses this seam.

A provider may add SDK details to `ProviderError.cause`, but it cannot create new host-visible failure codes — the code set is `ShellErrorCode`, and `layerShell` maps every provider failure onto a `ShellError` naming the `RemoteSandbox` module.

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

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smthrs/host` reference](host.md), and [failure and retry](../concepts/failure-and-retry.md).
