# `@flows/host-vercel`

This page is the public API reference for Vercel Edge host adapters, Node `/tmp` host support, remote sandbox seams, and server SQL composition. It distinguishes the package’s three export paths.

## Root edge export

```ts
import {
  VercelFileSystem,
  VercelHost,
  VercelHttpTransport,
  VercelJj,
  VercelPty,
  VercelSandbox,
  VercelShell
} from "@flows/host-vercel"
```

| Namespace | Public API |
| --- | --- |
| `VercelFileSystem` | `BlobBinding`, `KvBinding`, `Storage`, `make`, `layer` |
| `VercelHost` | `Options`, `VercelHost`, `implementationIds`, `layer`, `layerWithSandbox` |
| `VercelHttpTransport` | fetch-backed one-hop `layer` |
| `VercelShell`, `VercelPty`, `VercelJj` | typed unsupported layers |
| `VercelSandbox` | provider/session/binding types, `fromBinding`, `fromSandbox`, `makeProvider`, `layerWithSandbox` |

`Storage` is either `{ blob: BlobBinding }` or `{ kv: KvBinding }`. Directories are inferred from prefixes and `watch` is unsupported.

## Node export

```ts
import * as NodeVercelHost from "@flows/host-vercel/node"
```

`NodeVercelHost.layerEphemeral(root = "/tmp")` supplies the full Node host surface with filesystem paths confined below `root`. Storage is invocation-lifetime only.

## Server store export

```ts
import * as VercelStore from "@flows/host-vercel/store"
```

`VercelStore.layer({ sql })` wraps a caller-created Effect `SqlClient` with `Database.make`. `layerFromService` reads that client from the Effect environment. The module is intentionally absent from the Edge root export.

## Runtime boundary

The host and database pieces do not solve deferred/clock persistence, hermetic execution, ownership liveness, or reliable wake delivery. See the [Vercel guide](../guides/vercel.md) and [Implementation status](../architecture/implementation-status.md).
