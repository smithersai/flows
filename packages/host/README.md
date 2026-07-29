# @flows/host

@flows/host is the closed host capability surface. It defines Shell, Pty, Jj,
and HttpTransport, and uses Effect FileSystem and Path. It provides Node, Bun,
Browser, and Test platform layers plus the provider-neutral `RemoteSandbox`
adapter. Edge-specific implementations live in the
separate `@flows/host-cloudflare` and `@flows/host-vercel` packages. A
Bun deployment uses `BunHost.layer`.

The root exports HostError, HostServices flat, and the HttpTransport, Jj, Pty,
Shell, BrowserHost, NodeHost, and TestHost namespaces.

```text
HostService =
  FileSystem | Path | Shell | Pty | Jj | HttpTransport

NodeHost.layer   = NodeFileSystem + NodeHttpTransport + NodeShell + NodePty + NodeJj
BunHost.layer    = BunFileSystem + Path + BunHttpTransport + BunShell + BunPty + BunJj
BrowserHost.layer({ bash, fs }) = BrowserFileSystem + BrowserHttpTransport
                                  + Path + JustBashShell + unsupported Pty + unsupported Jj
TestHost.layer(options?) = deterministic browser adapters + TestClock + seeded Random
```

```ts
import { NodeHost, Shell } from "@flows/host"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const shell = yield* Shell.Shell
  return yield* shell.exec("echo hi")
})

Effect.runPromise(Effect.provide(program, NodeHost.layer))
```

See the [reference](../../docs/reference/host.md) for service signatures,
stable error codes, platform details, and links to the edge-host packages.
