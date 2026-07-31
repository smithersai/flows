# Hosts and capabilities

This page describes the portable host surface and the permission kernel that mediates side effects. It covers engine-facing filesystem, process, network, and workspace operations, not higher-level application policy.

## The closed host surface

`@smithers/host` defines these protected services:

- Effect `FileSystem`
- Effect `Path`
- `Shell`
- `Pty`
- `Jj`
- one-hop `HttpTransport`

Clock and Random are tracked as host built-ins. Node, Bun, browser, test, Cloudflare, and Vercel packages supply different layers for the same service tags. Unsupported operations fail through their service contract; they should not disappear from the environment type.

`HttpTransport` intentionally performs one request without automatic redirect following. Redirect policy belongs above the raw adapter so every network hop can be authorized.

## Kernel decoration

The kernel exports parallel services such as `FileSystem`, `Shell`, `Pty`, `Jj`, and `HttpClient`. Each decorator:

1. derives an exact `Capability`,
2. asks `GrantStore` to authorize it,
3. calls the raw host service only when allowed.

```ts
import { Capability, Permission } from "@smithers/kernel"

const rule = new Permission.Rule({
  effect: "allow",
  pattern: new Capability.CapabilityPattern({
    action: "fs:read",
    resource: "/workspace/**"
  })
})
```

Capability matching normalizes path separators and matches the whole resource. `Capability.subsumes` is deliberately conservative: it returns `false` when containment cannot be proven syntactically.

## Ambient authority

`CapabilitySet` represents the current envelope. Nested code can only narrow authority by intersection; it cannot widen the set inherited from its caller. `Workspace` provides the root used to resolve and normalize path capabilities.

Pure path manipulation is not permission-checked. Filesystem access derived from a path is.

## Grant stores

`GrantStore` supports `once`, `run`, `remembered`, and `deny` resolutions. `JournalGrantStore` persists grant events in the engine journal. `makeNoop` is an explicit allow-all seam, and test grant layers provide scripted behavior; a production deployment should install a deliberate policy.

The kernel is a capability check, not an operating-system sandbox. Hermetic execution also requires an implementation of the [`StepBoundary`](../reference/engine-store.md#stepboundary) contract that can observe and restrict actual reads and writes.

## Adapter limitations

- The browser layer wraps an injected ZenFS-like promises API.
- Cloudflare and Vercel filesystems use object or key/value storage rather than full POSIX semantics.
- Default Cloudflare and Vercel `Shell`, `Pty`, and `Jj` layers are unsupported/no-op adapters; sandbox-backed shell variants are available.
- The Node-flavored Vercel host uses ephemeral `/tmp` storage.

See the [`@smithers/host` reference](../reference/host.md), [`@smithers/kernel` reference](../reference/kernel.md), and deployment guides for [Cloudflare](../guides/cloudflare.md) and [Vercel](../guides/vercel.md).
