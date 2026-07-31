# @smithers/host

Closed host-capability boundary for flows. It defines portable Shell, Pty, Jj,
and single-hop HTTP contracts alongside Effect FileSystem and Path, then
provides Node, Bun, browser, remote-sandbox, and deterministic test adapters.

```sh
npm install @smithers/host
```

## Public API

Root service modules are namespaced and can also be imported from matching
subpaths such as `@smithers/host/Shell`.

| Export               | Public exports                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host services (flat) | `HostService`, `HostServiceTags`, `HostServiceIds`, and `HostBuiltinNames` define the closed `FileSystem \| Path \| Shell \| Pty \| Jj \| HttpTransport` surface plus Effect's Clock/Random names. |
| `HostError`          | `ShellErrorCode`, `ShellError`, `PtyErrorCode`, `PtyError`, `JjErrorCode`, `JjError`, and `HostError`; constructors `shellError`, `ptyError`, and `jjError`.                                       |
| `HttpTransport`      | `HttpTransport` interface/tag for one non-redirecting request; `make`, `makeNoop`, and `layerNoop`.                                                                                                |
| `Jj`                 | `ChangeId`, the `Jj` interface/tag (`snapshot`, `restore`, `diff`, workspace operations, `status`), plus `make`, `makeNoop`, and `layerNoop`.                                                      |
| `Pty`                | `PtySpawnOptions`, scoped `PtyHandle`, and `Pty` interface/tag; `make`, `makeNoop`, and `layerNoop`.                                                                                               |
| `Shell`              | `ShellOptions`, `ShellResult`, `ShellChunk`, and the buffered/streaming `Shell` interface/tag; `make`, `makeNoop`, and `layerNoop`.                                                                |
| `BrowserHost`        | `layer({ bash, fs })` plus `layerPtyUnsupported` and `layerJjUnsupported`.                                                                                                                         |
| `BunHost`            | `BunHost`, `implementationIds`, and complete `layer`; re-exported adapter namespaces `BunFileSystem`, `BunHttpTransport`, `BunJj`, `BunPty`, and `BunShell`.                                       |
| `NodeHost`           | `NodeHost` and complete `layer`; re-exported adapter namespaces `NodeHttpTransport`, `NodeJj`, `NodePty`, and `NodeShell`.                                                                         |
| `RemoteSandbox`      | `ProviderError`, `Provider` interface/tag, and `layerShell`; scripted-test models `TestScript`, `TestSandboxState`, `TestSandboxProvider`, and `TestSandbox.make`.                                 |
| `TestHost`           | `makeMemoryFs`, `makeStubBash`, `layerSeededRandom`, configurable `layer`, and zero-config `TestHost` layer.                                                                                       |

Additional public adapter subpaths are:

| Subpath modules                                                                        | Public exports                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/BrowserFileSystem`                                                            | `ZenFsPromisesLike`, `ZenFsFileHandleLike`, `ZenFsStatsLike`, `make`, `layer`.                                                                                                                      |
| `browser/BrowserHttpTransport`                                                         | `layer`.                                                                                                                                                                                            |
| `browser/JustBashShell`                                                                | `JustBashLike`, `layer`.                                                                                                                                                                            |
| `bun/BunFileSystem`, `bun/BunHttpTransport`, `bun/BunJj`, `bun/BunPty`, `bun/BunShell` | Each exports its service `layer`.                                                                                                                                                                   |
| `node/NodeHttpTransport`, `node/NodeJj`, `node/NodePty`, `node/NodeShell`              | Each exports its service `layer`.                                                                                                                                                                   |
| `test/TestHost`                                                                        | Same helpers exposed by the root `TestHost` namespace.                                                                                                                                              |
| `test/contract`                                                                        | `FailureCapability`, `FileSystemSuccess`, `PathSuccess`, `ShellSuccess`, `PtySuccess`, `JjSuccess`, `HttpTransportSuccess`, `HostContractCapabilities`, `HostContractLayer`, and `runHostContract`. |

```ts
import { NodeHost, Shell } from "@smithers/host"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const shell = yield* Shell.Shell
  return yield* shell.exec("echo hi")
}).pipe(Effect.provide(NodeHost.layer))

Effect.runPromise(program)
```

Closing an Effect scope or interrupting its owning fiber controls process and
remote-session cancellation; these contracts do not use `AbortSignal`.

See the [host reference](../../docs/reference/host.md),
[Host Adapters](../../../docs/specs/Concepts/Host%20Adapters.md), and
[Effect Taxonomy](../../../docs/specs/Concepts/Effect%20Taxonomy.md).
