# @smthrs/host

Closed machine-facing service contracts, their errors, and the Node, Bun, browser, and test bundles that implement them.

```ts
import { HostServiceTags, Shell } from "@smthrs/host"
import * as NodeHost from "@smthrs/host/node/NodeHost"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const shell = yield* Shell.Shell
  return yield* shell.exec("printf hello")
}).pipe(Effect.provide(NodeHost.layer))
```

The package root holds contracts and no-op layers only, so it bundles for the browser. Platform bundles live under `/node`, `/bun`, `/browser`, and `/test`.

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/host` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/index.ts) | any |
| `@smthrs/host/node/NodeHost` | [src/node/NodeHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/node/NodeHost.ts) | Node |
| `@smthrs/host/bun/BunHost` | [src/bun/BunHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/bun/BunHost.ts) | Bun |
| `@smthrs/host/browser/BrowserHost` | [src/browser/BrowserHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/browser/BrowserHost.ts) | browser |
| `@smthrs/host/test/TestHost` | [src/test/TestHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/test/TestHost.ts) | Node |
| `@smthrs/host/test/contract` | [src/test/HostContract.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/test/HostContract.ts) | Node |

## Root exports

`HostServices` members are exported at the root without a namespace. Everything else is a namespace re-export.

### HostServices

[src/HostServices.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/HostServices.ts)

| Export | Kind | Value or shape |
| --- | --- | --- |
| `HostService` | type | `FileSystem \| Path \| Shell \| Pty \| Jj \| HttpTransport` |
| `HostServiceTags` | const | the six service tags at runtime |
| `HostServiceIds` | const | `effect/FileSystem`, `effect/Path`, `flows/host/Shell`, `flows/host/Pty`, `flows/host/Jj`, `flows/host/HttpTransport` |
| `HostBuiltinNames` | const | `effect/Clock`, `effect/Random` |

### Shell

[src/Shell.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/Shell.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ShellOptions` | interface | `cwd`, `env`, `timeoutMs`, `stdin` |
| `ShellResult` | interface | `stdout`, `stderr`, `exitCode` |
| `ShellChunk` | interface | `kind: "stdout" \| "stderr"`, `chunk: Uint8Array` |
| `Shell` | interface | `exec`, `stream` |
| `Shell` | service tag | `flows/host/Shell` |
| `make` | constructor | derives `stream` from `exec` when the platform cannot stream |
| `makeNoop` | constructor | every method fails `shell_unavailable` until overridden |
| `layerNoop` | layer | `makeNoop` as a `Layer` |

### Pty

[src/Pty.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/Pty.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `PtySpawnOptions` | interface | spawn arguments |
| `PtyHandle` | interface | live terminal handle |
| `Pty` | interface | pseudo-terminal operations |
| `Pty` | service tag | `flows/host/Pty` |
| `make`, `makeNoop` | constructors | |
| `layerNoop` | layer | |

### Jj

[src/Jj.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/Jj.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ChangeId` | type | string handle for workspace state |
| `Jj` | interface | `snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, `status` |
| `Jj` | service tag | `flows/host/Jj` |
| `make`, `makeNoop` | constructors | `makeNoop` fails `not_installed` |
| `layerNoop` | layer | |

### HttpTransport

[src/HttpTransport.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/HttpTransport.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `HttpTransport` | interface | one request, no automatic redirect following |
| `HttpTransport` | service tag | `flows/host/HttpTransport` |
| `make`, `makeNoop` | constructors | |
| `layerNoop` | layer | |

### HostError

[src/HostError.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/HostError.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ShellError`, `PtyError`, `JjError` | classes | tagged errors with a `code` |
| `ShellErrorCode`, `PtyErrorCode`, `JjErrorCode` | const + type | code literals |
| `HostError` | type | union of the three |
| `shellError`, `ptyError`, `jjError` | constructors | build an error from a code plus context |

### RemoteSandbox

[src/RemoteSandbox.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/RemoteSandbox.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ProviderError` | class | sandbox provider failure |
| `Provider` | interface + service tag | remote sandbox provider |
| `layerShell` | layer | a `Shell` backed by a provider |
| `TestScript`, `TestSandboxState`, `TestSandboxProvider` | interfaces | scripted provider fixtures |
| `TestSandbox` | const | scripted provider |

### SandboxHealth

[src/SandboxHealth.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/SandboxHealth.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Healthy`, `Unhealthy` | classes | health states |
| `HealthState` | const + type | union schema |
| `UnhealthyReason` | const + type | reason literals |
| `PingProvider`, `ProbeOptions`, `Service` | interfaces | probe inputs |
| `probe` | function | runs a bounded liveness probe |
| `SandboxHealth` | service tag | |
| `make`, `makeNoop` | constructors | |
| `layer`, `layerNoop` | layers | |

## Platform bundles

| Export | Source | Notes |
| --- | --- | --- |
| `NodeHost.layer`, `NodeHost.NodeHost` | [node/NodeHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/node/NodeHost.ts) | child processes, `node:fs`, PTY, jj |
| `NodeShell.layer`, `NodePty.layer`, `NodeJj.layer`, `NodeHttpTransport.layer` | `src/node/` | individual Node adapters |
| `BunHost.layer`, `BunHost.implementationIds` | [bun/BunHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/bun/BunHost.ts) | falls back to the Node adapters off Bun |
| `BunShell.make`, `BunShell.layer`, `BunFileSystem.layer`, `BunJj.layer`, `BunPty.layer`, `BunHttpTransport.layer` | `src/bun/` | individual Bun adapters |
| `BrowserHost.layer` | [browser/BrowserHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/browser/BrowserHost.ts) | takes `{ bash, fs }`; PTY and jj report unsupported |
| `BrowserHost.layerPtyUnsupported`, `BrowserHost.layerJjUnsupported` | same | typed unavailable layers |
| `BrowserFileSystem.make`, `BrowserFileSystem.layer` | [browser/BrowserFileSystem.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/browser/BrowserFileSystem.ts) | over a ZenFS-like promises API |
| `JustBashShell.layer` | [browser/JustBashShell.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/browser/JustBashShell.ts) | browser shell over a `JustBashLike` runtime |
| `TestHost.layer`, `TestHost.TestHost`, `TestHost.makeMemoryFs`, `TestHost.makeStubBash`, `TestHost.layerSeededRandom` | [test/TestHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/test/TestHost.ts) | deterministic in-memory host |

## Host contract suite

`@smthrs/host/test/contract` ships the conformance suite every adapter runs.

| Export | Kind | Notes |
| --- | --- | --- |
| `runHostContract` | function | runs the suite against a layer and a capability declaration |
| `HostContractCapabilities`, `HostContractLayer` | types | what an adapter declares it supports |
| `FileSystemSuccess`, `PathSuccess`, `ShellSuccess`, `PtySuccess`, `JjSuccess`, `HttpTransportSuccess` | interfaces | per-service capability declarations |
| `FailureCapability` | interface | expected failure declaration |
| `errorCode`, `assertFailure`, `defaultScratchPath` | helpers | |

## Reading next

`@smthrs/kernel` decorates these same tags with capability checks. `@smthrs/time-travel` uses `Jj` for workspace snapshot and restore.
