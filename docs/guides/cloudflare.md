# Deploying host services on Cloudflare

This guide explains the Cloudflare host and database adapters that exist today. It does not claim that the full durable engine can run in a Worker without additional application-owned services.

## Host layer

Provide an object store implementing `CloudflareFileSystem.ObjectStore`:

```ts
import {
  CloudflareHost,
  CloudflareSandbox
} from "@flows/host-cloudflare"

const HostLayer = CloudflareHost.layer(objectStore)
```

The layer supplies filesystem, path, HTTP transport, shell, PTY, and Jujutsu tags. Files use object-storage semantics. Fetch supplies the one-hop HTTP transport. Shell, PTY, and Jujutsu are unsupported in the default edge layer.

To route shell commands to a remote sandbox:

```ts
const provider = CloudflareSandbox.fromBinding((session) =>
  openSandboxClient(session)
)
const HostLayer = CloudflareHost.layerWithSandbox(objectStore, provider)
```

`CloudflareSandboxSdk.fromNamespace` adapts the Cloudflare Sandbox SDK namespace. The generic `fromBinding` seam avoids a hard SDK dependency.

## Durable Object database

`CloudflareStore.layer(storage)` wraps a Durable Object’s synchronous SQL storage as `@flows/database`. Use one Durable Object as the serialization boundary for the journal and related stores, then run journal migrations before serving work.

This database adapter is separate from `CloudflareFileSystem`: the former stores engine rows, while the latter exposes workflow-visible files.

## Current blockers for the full engine

`EngineStore` itself imports Node owner-identity APIs. Its only bundled `DurableEngineState` is in-memory, and no production `StepBoundary` is included. A fully restart-durable Worker composition therefore needs an edge-safe engine-store change plus persistent deferred/clock and boundary implementations. Those pieces are **Planned**.

You can use the Cloudflare host and database adapters independently now. Do not substitute the no-op shell/Jujutsu services for workloads that declare those capabilities.

See the [`@flows/host-cloudflare` reference](../reference/host-cloudflare.md), [Hosts and capabilities](../concepts/hosts-and-capabilities.md), and [Implementation status](../architecture/implementation-status.md).
