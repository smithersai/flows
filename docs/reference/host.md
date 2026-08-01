# `@smithers/host`

This page is the public API reference for the raw portable host surface and its platform bundles. Permission enforcement is provided separately by `@smithers/kernel`.

## Closed service set

The root exports `HostService`, `HostServiceTags`, `HostServiceIds`, and `HostBuiltinNames`. The protected service set is Effect `FileSystem`, Effect `Path`, `Shell`, `Pty`, `Jj`, and `HttpTransport`; Clock and Random are the named built-ins.

## Service namespaces

| Namespace | Main public API |
| --- | --- |
| `Shell` | `Shell` tag; `exec`, `stream`; `ShellOptions`, `ShellResult`, `ShellChunk`; `make`, `makeNoop`, `layerNoop` |
| `Pty` | `Pty` tag; scoped `spawn`; `PtyHandle` write/resize/output/attach/exit; constructors and no-op layer |
| `Jj` | `Jj` tag; `snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, `status`; constructors and no-op layer |
| `HttpTransport` | one-hop `execute`; `make`, `makeNoop`, `layerNoop` |
| `HostError` | `ShellError`, `PtyError`, `JjError`, code schemas, and constructor helpers |
| `RemoteSandbox` | `Provider`, `ProviderError`, `layerShell`, and scripted `TestSandbox` |
| `SandboxHealth` | `SandboxHealth` tag; `probe` with a deadline; `Healthy`/`Unhealthy` (`component: "sandbox"`, closed `UnhealthyReason`); `PingProvider`; `make`, `makeNoop`, `layer`, `layerNoop` |

Shell cancellation is Effect fiber interruption. PTY handles and remote-sandbox acquisition require `Scope`.

A PTY output stream ends when the child's stdio pipes close, not when the child is reaped: `exitCode` resolves on the child's `exit`, while `output`/`attach` keep delivering anything still buffered in the pipe (or written by a grandchild that inherited it) until it closes.

## Platform bundles

| Namespace | Layer |
| --- | --- |
| `NodeHost` | `layer` using Node filesystem/path, child processes, PTY, Jujutsu, and HTTP |
| `BunHost` | `layer` using Bun adapters with compatible fallbacks |
| `BrowserHost` | `layer(options)` over injected browser filesystem and bash-like bindings; PTY/Jujutsu unavailable |
| `TestHost` | `layer(options?)` with memory files, scripted commands, test clock, and seeded Random |

`BunShell` also exports `make(runtime)`, which builds the `Shell` over an explicit `BunRuntime` (`{ spawn }`) instead of the `Bun` global. `layer` is `Layer.suspend`ed: on Bun it binds `make` to `Bun.spawn` (resolved per spawn, so a `Bun` global without `spawn` fails with `shell_unavailable` rather than dying at layer construction), and off Bun it is `NodeShell.layer`. Because host tests and CI run on Node, the `BunHost` contract suite exercises the fallback only; the `Bun.spawn` paths — stdin, timeout kill, interrupt finalizer, streaming — are covered by driving `make` with a fake runtime in `packages/host/test/BunShell.test.ts`.

`TestHost` additionally exports `makeMemoryFs`, `makeStubBash`, `layerSeededRandom`, and a zero-option `TestHost` layer.

```ts
const HostLayer = TestHost.layer({
  files: { "/input.txt": "data" },
  commands: { "tool --version": { stdout: "1.0\n" } },
  seed: 42
})
```

## Deep imports

Package exports allow public module imports such as `@smithers/host/node/NodeShell` and `@smithers/host/browser/BrowserFileSystem`; `internal/*` is blocked. Prefer the root namespaces unless constructing a custom bundle.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smithers/kernel` reference](kernel.md), and the hosted adapters for [Cloudflare](https://github.com/smithersai/plugins/blob/main/docs/reference/host-cloudflare.md) and [Vercel](https://github.com/smithersai/plugins/blob/main/docs/reference/host-vercel.md).
