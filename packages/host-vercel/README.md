# @flows/host-vercel

Vercel host layers for the closed six-service `@flows/host` surface:
`FileSystem`, `Path`, `Shell`, `Pty`, `Jj`, and `HttpTransport`.

The root entry is Edge-safe. `VercelHost.layer({ storage })` uses an injected
Blob or KV structural binding, fetch, and typed unavailable failures for local
shell, PTY, and jj. `VercelHost.layerWithSandbox` replaces only Shell with the
provider-neutral `RemoteSandbox.Provider` layer.

The Node entry is `@flows/host-vercel/node`. Its `layerEphemeral` confines the
filesystem to `/tmp` and provides local process capabilities. `/tmp` is
invocation-lifetime storage: it may disappear between invocations and is not a
persistence layer. The server-only database binding is
`@flows/host-vercel/store`; pass it a PostgreSQL `SqlClient` created by the
deployment's `@effect/sql-pg` integration.

Blob/KV directories are inferred from key prefixes. Object storage has no
portable watch stream, so `FileSystem.watch` fails with a typed platform error
and is tracked in `.smithers/tickets/vercel-blob-filesystem-watch.md`.

See the [package reference](../../docs/reference/host-vercel.md).
