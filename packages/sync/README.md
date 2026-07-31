# @smithers/sync

Browser-safe, read-only replication of canonical `@smithers/journal` entries.
It defines the wire protocol, RPC group, server, and replay-then-follow client;
journal mutation remains outside this package.

```sh
npm install @smithers/sync
```

## Public API

The root exports these namespaces, also available from matching
`@smithers/sync/*` subpaths.

| Namespace      | Public exports                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncError`    | `ErrorCode` schema/type, general `SyncError` with guard `SyncError.is`, and terminal `SyncGapError`.                                                                                                                                                          |
| `SyncProtocol` | Scope schemas `WorkspaceScope`, `RunScope`, and `Scope`; cursor schemas/types `RunCursor` and `WorkspaceCursor`; `ReadRequest`, `ReadResponse`, and `SubscribeRequest`; `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, and `Frame`; `covers(scope, runId)`. |
| `SyncRpcs`     | `SyncRpcs` defines `Sync.Read` and streaming `Sync.Subscribe`; `SyncAuth` is the RPC middleware service.                                                                                                                                                      |
| `RunCatalog`   | `RunCatalog` / `Service` list runs and expose changes. `make`, `layerStatic`, `makeMemory`, and `layerNoop` provide implementations.                                                                                                                          |
| `SyncServer`   | `SyncServer` / `Service`, `make`, `makeNoop`, and `layerNoop`; `makeLive` / `layer` implement journal replay and follow using `Journal` and `RunCatalog`.                                                                                                     |
| `SyncClient`   | `Sync` / `Service` expose `subscribe` and materialized `cursors`; `SubscribeOptions`, `make`, `makeNoop`, `layer`, and `layerNoop` construct the browser-safe client.                                                                                         |

Public test subpaths are `@smithers/sync/test/TestSocket` (`FrameFilter`,
`TestFaults`, `Pair`, `makePair`) and `@smithers/sync/test/TestSync`
(`layerTest`, `layerNoop`, `connect`).

```ts
import { RunCatalog, SyncServer } from "@smithers/sync"
import { Effect, Layer } from "effect"

const serverLayer = SyncServer.layer.pipe(
  Layer.provide(RunCatalog.layerStatic([]))
)

const program = Effect.gen(function*() {
  return yield* SyncServer.SyncServer
}).pipe(Effect.provide(serverLayer))
```

`Read` pages durable entries, then the client subscribes from exclusive
per-run cursors. A non-contiguous journal sequence is valid; `SyncGapError`
means the server skipped beyond the interval covered by the client's cursor.

See the [sync reference](../../docs/reference/sync.md) and
[Sync Decision](../../../docs/specs/Research/Sync%20Decision%202026-07-28.md).
