# @smithers/host

Closed host-capability boundary for flows. It defines portable Shell, Pty, Jj,
and single-hop HTTP contracts alongside Effect FileSystem and Path, then
provides Node, Bun, browser, remote-sandbox, and deterministic test adapters.

```sh
npm install @smithers/host
```

## Entry points

The root is **platform-neutral and browser-bundleable**: contracts, errors, and
no-op layers only. Every platform bundle lives under an explicit subpath, the
way `effect` keeps `@effect/platform-node` out of `effect`, so importing a
contract never resolves a `node:` built-in.

| Import                               | Platform                                             |
| ------------------------------------ | ---------------------------------------------------- |
| `@smithers/host`                     | any — contracts only; bundles for the browser        |
| `@smithers/host/browser/BrowserHost` | browser                                              |
| `@smithers/host/node/NodeHost`       | Node (`node:child_process`, `@effect/platform-node`) |
| `@smithers/host/bun/BunHost`         | Bun, falling back to the Node adapters off Bun       |
| `@smithers/host/test/TestHost`       | Node — `effect/testing` pulls `node:assert`          |

`npm run browser` at the repository root bundles the first two with
`platform: "browser"` and fails the build if either stops being browser-safe.
It asserts the other three still do not bundle, so this table cannot go stale.

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
| `RemoteSandbox`      | `ProviderError`, `Provider` interface/tag, and `layerShell`; scripted-test models `TestScript`, `TestSandboxState`, `TestSandboxProvider`, and `TestSandbox.make`.                                 |
| `SandboxHealth`      | `SandboxHealth` interface/tag with deadline-bounded `probe`; `PingProvider`, `make`, `makeNoop`, `layer`, and `layerNoop`.                                                                         |

The platform bundles and their adapters are public subpaths:

| Subpath modules                                                                        | Public exports                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/BrowserHost`                                                                  | `layer({ bash, fs })` plus `layerPtyUnsupported` and `layerJjUnsupported`.                                                                                                                          |
| `bun/BunHost`                                                                          | `BunHost`, `implementationIds`, and complete `layer`; re-exported adapter namespaces `BunFileSystem`, `BunHttpTransport`, `BunJj`, `BunPty`, and `BunShell`.                                        |
| `node/NodeHost`                                                                        | `NodeHost` and complete `layer`; re-exported adapter namespaces `NodeHttpTransport`, `NodeJj`, `NodePty`, and `NodeShell`.                                                                          |
| `test/TestHost`                                                                        | `makeMemoryFs`, `makeStubBash`, `layerSeededRandom`, configurable `layer`, and zero-config `TestHost` layer.                                                                                        |
| `browser/BrowserFileSystem`                                                            | `ZenFsPromisesLike`, `ZenFsFileHandleLike`, `ZenFsStatsLike`, `make`, `layer`.                                                                                                                      |
| `browser/BrowserHttpTransport`                                                         | `layer`.                                                                                                                                                                                            |
| `browser/JustBashShell`                                                                | `JustBashLike`, `layer`.                                                                                                                                                                            |
| `bun/BunFileSystem`, `bun/BunHttpTransport`, `bun/BunJj`, `bun/BunPty`, `bun/BunShell` | Each exports its service `layer`.                                                                                                                                                                   |
| `node/NodeHttpTransport`, `node/NodeJj`, `node/NodePty`, `node/NodeShell`              | Each exports its service `layer`.                                                                                                                                                                   |
| `test/contract`                                                                        | `FailureCapability`, `FileSystemSuccess`, `PathSuccess`, `ShellSuccess`, `PtySuccess`, `JjSuccess`, `HttpTransportSuccess`, `HostContractCapabilities`, `HostContractLayer`, and `runHostContract`. |

```ts
import { Shell } from "@smithers/host"
import * as NodeHost from "@smithers/host/node/NodeHost"
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
