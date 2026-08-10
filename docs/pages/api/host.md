# @smthrs/host

The closed machine-facing service list, the `Shell` and `HttpTransport` contracts, and the Node, Bun, browser, and test bundles that implement all five tags.

`Jj` and the sandbox modules are their own packages — [@smthrs/jj](jj.md), [@smthrs/sandbox](sandbox.md). This package depends on the former so the closed list can name it, but nothing here re-exports it: import each service from its own package. There is no `Pty` service — interactive-terminal support is out of core, see [design decisions](/design-decisions). The browser filesystem left too, for a different reason: it implements `effect`'s own `FileSystem`, not anything this package declares, so it lives in [@smthrs/platform-browser](platform-browser.md) beside the browser `ChildProcessSpawner`.

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
| `HostService` | type | `FileSystem \| Path \| Shell \| Jj \| HttpTransport` |
| `HostServiceTags` | const | the five service tags at runtime |
| `HostServiceIds` | const | `effect/FileSystem`, `effect/Path`, `flows/host/Shell`, `flows/host/Jj`, `flows/host/HttpTransport` |
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
| `ShellError` | class | tagged error with a `code` |
| `ShellErrorCode` | const + type | code literals |
| `HostError` | type | union of `ShellError` and `JjError` — the latter is a type imported from its own package, not a re-export |
| `shellError` | constructor | builds an error from a code plus context |

## Platform bundles

| Export | Source | Notes |
| --- | --- | --- |
| `NodeHost.layer`, `NodeHost.NodeHost` | [node/NodeHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/node/NodeHost.ts) | child processes, `node:fs`, jj |
| `NodeShell.layer`, `NodeHttpTransport.layer` | `src/node/` | individual Node adapters owned by this package |
| `BunHost.layer`, `BunHost.implementationIds` | [bun/BunHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/bun/BunHost.ts) | falls back to the Node adapters off Bun; `implementationIds` are frozen identity tokens, not import specifiers |
| `BunShell.make`, `BunShell.layer`, `BunFileSystem.layer`, `BunHttpTransport.layer` | `src/bun/` | individual Bun adapters owned by this package |
| `BrowserHost.layer` | [browser/BrowserHost.ts](https://github.com/smithersai/flows/blob/main/packages/host/src/browser/BrowserHost.ts) | takes `{ bash, fs }`; installs the jj package's `layerUnsupported` and `@smthrs/platform-browser`'s `BrowserFileSystem` |
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

`@smthrs/kernel` decorates these same tags with capability checks. The `Jj` contract is documented in [@smthrs/jj](jj.md), remote execution in [@smthrs/sandbox](sandbox.md), and `@smthrs/time-travel` uses `Jj` for workspace snapshot and restore.
