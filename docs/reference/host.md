# `@smthrs/host`

This page is the public API reference for the raw portable host surface and its platform bundles. Permission enforcement is provided separately by `@smthrs/kernel`.

## Closed service set

The root exports `HostService`, `HostServiceTags`, `HostServiceIds`, and `HostBuiltinNames`. The protected service set is Effect `FileSystem`, Effect `Path`, `Shell`, `Pty`, `Jj`, and `HttpTransport`; Clock and Random are the named built-ins.

`Pty` and `Jj` are contracts of [`@smthrs/pty`](pty.md) and [`@smthrs/jj`](jj.md), and remote sandboxes are [`@smthrs/sandbox`](sandbox.md). This package depends on the first two so the closed list can name them; it does **not** re-export them, and neither do the composite bundles. Import each service from its own package. Their tag keys are still `flows/host/Pty` and `flows/host/Jj`: those strings are digested into step keys, so a package move must not rename them.

## Service namespaces

| Namespace | Main public API |
| --- | --- |
| `Shell` | `Shell` tag; `exec`, `stream`; `ShellOptions`, `ShellResult`, `ShellChunk`; `make`, `makeNoop`, `layerNoop` |
| `HttpTransport` | one-hop `execute`; `make`, `makeNoop`, `layerNoop` |
| `HostError` | `ShellError`, `ShellErrorCode`, `shellError`, and the `HostError` union (which names `PtyError` and `JjError` as types from their packages) |

Shell cancellation is Effect fiber interruption. PTY handles and remote-sandbox acquisition require `Scope`.

## Platform bundles

Platform bundles are **not** root exports. The root is the portable contract surface and bundles for the browser; each implementation is imported from its own subpath, the way `effect` keeps `@effect/platform-node` out of `effect`.

| Import | Layer |
| --- | --- |
| `@smthrs/host/node/NodeHost` | `layer` using Node filesystem/path, child processes, PTY, Jujutsu, and HTTP |
| `@smthrs/host/bun/BunHost` | `layer` using Bun adapters with compatible fallbacks |
| `@smthrs/host/browser/BrowserHost` | `layer(options)` over injected browser filesystem and bash-like bindings; installs `BrowserPty.layerUnsupported` and `BrowserJj.layerUnsupported` |
| `@smthrs/host/test/TestHost` | `layer(options?)` with memory files, scripted commands, test clock, and seeded Random |

```ts
import { Shell } from "@smthrs/host"
import * as NodeHost from "@smthrs/host/node/NodeHost"
```

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

Package exports allow public module imports such as `@smthrs/host/node/NodeShell` and `@smthrs/host/browser/BrowserFileSystem`; `internal/*` is blocked. Prefer the root namespaces for contracts, and the platform subpaths above for implementations. The pty and jj adapters are **not** here: they are `@smthrs/pty/node/NodePty`, `@smthrs/pty/bun/BunPty`, `@smthrs/jj/node/NodeJj`, and `@smthrs/jj/bun/BunJj`.

## Browser support

`@smthrs/host` and `@smthrs/host/browser/BrowserHost` are gated as browser entry points by `scripts/browser-check.mjs` (`npm run browser`, and one CI step): both are bundled with esbuild's `platform: "browser"` and any resolution error fails the build. The same gate asserts that the Node, Bun, and test bundles still do *not* bundle for the browser (`node:child_process`, `node:fs`, and — through `effect/testing`'s `TestClock` — `node:assert`), so the split cannot silently erode in either direction. See [browser support](../architecture/browser-support.md) for the repository-wide matrix.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smthrs/jj`](jj.md), [`@smthrs/pty`](pty.md), and [`@smthrs/sandbox`](sandbox.md) references, the [`@smthrs/kernel` reference](kernel.md), and the hosted adapters for [Cloudflare](https://github.com/smithersai/plugins/blob/main/docs/reference/host-cloudflare.md) and [Vercel](https://github.com/smithersai/plugins/blob/main/docs/reference/host-vercel.md).
