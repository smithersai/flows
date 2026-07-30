# `@flows/host-cloudflare`

This page is the public API reference for Cloudflare Workers host adapters, remote sandbox seams, and the Durable Object SQL database layer. It does not provide a complete edge-safe workflow engine.

## Root namespaces

| Namespace | Public API |
| --- | --- |
| `CloudflareFileSystem` | `ObjectStore`, `make(store)`, `layer(store)` |
| `CloudflareHost` | `CloudflareHost` type, `implementationIds`, `layer(store)`, `layerWithSandbox(store, provider)` |
| `CloudflareHttpTransport` | Workers-fetch `layer` |
| `CloudflareShell` | unsupported `layer` |
| `CloudflarePty` | unsupported `layer` |
| `CloudflareJj` | unsupported `layer` |
| `CloudflareSandbox` | provider types, `fromBinding`, `layer`, and `layerShell` |
| `CloudflareStore` | `layer(DurableObjectStorage)` |

`CloudflareFileSystem.ObjectStore` is structural:

```ts
interface ObjectStore {
  get(key: string): Promise<Uint8Array | undefined>
  put(key: string, value: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<ReadonlyArray<string>>
}
```

Directories use `.flows-dir` markers. `watch` is unsupported because the injected object store has no change feed.

## Sandbox SDK adapter

`CloudflareSandboxSdk` is available as a public deep module and exports `fromNamespace`. It adapts the optional Cloudflare Sandbox SDK namespace to `CloudflareSandbox.SandboxProvider`; it is not re-exported from the package root.

## Durable Object SQL

`CloudflareStore.layer(storage)` builds `Database` with `@effect/sql-sqlite-do`. Effect SQL transactions delegate to the Durable Object storage transaction boundary. Run [`Journal.Migrations`](journal.md#migrations) before using journal stores.

## Runtime boundary

The default host layer is edge-safe, but `EngineStore` currently imports Node
identity APIs and ships no production `StepBoundary`. The persistent
`DurableEngineState` requires a compatible `Database` layer. See the
[Cloudflare guide](../guides/cloudflare.md) before composing the full engine.
