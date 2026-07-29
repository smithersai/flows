# @flows/host-cloudflare

Workers-safe implementation of the closed flows Host surface. Inject an R2 or Durable Object object binding into `CloudflareHost.layer`; directory entries are emulated with `.flows-dir` marker objects. `watch`, local shell, local PTY, and local jj remain present as typed failures with tracked tickets. Use `layerWithSandbox` for remote container shell execution.

`CloudflareStore.layer(storage)` binds a Durable Object SQLite `storage` handle to `@flows/database`. Its transactions use Durable Object storage transactions; it does not use D1.

See the [package reference](../../docs/reference/host-cloudflare.md).
