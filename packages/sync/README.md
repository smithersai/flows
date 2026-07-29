# @flows/sync

`@flows/sync` is the browser-safe, read-only replication layer for canonical `@flows/journal` entries. `@flows/control` owns mutations; sync never writes a journal entry.

## Key exports

| Module         | Owns                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `SyncProtocol` | Scope, cursors, RPC request/response schemas, frames, and `covers`.  |
| `SyncRpcs`     | `Sync.Read`, streaming `Sync.Subscribe`, `Sync.Ack`, and `SyncAuth`. |
| `SyncServer`   | Journal replay and follow implementation.                            |
| `SyncClient`   | Browser-safe replay-then-follow service.                             |
| `RunCatalog`   | Workspace run enumeration and change feed port.                      |
| `SyncError`    | Stable sync failures and terminal `SyncGapError`.                    |

## Layer wiring

Provide `SyncServer.layer` with `Journal.Journal` and `RunCatalog.RunCatalog`. Provide `SyncClient.layer` with an Effect RPC client protocol. `RunCatalog` has `layerStatic`, `makeMemory`, and `layerNoop`; both client and server have `layerNoop` stubs.

```ts
import * as RunCatalog from "@flows/sync/RunCatalog"
import * as SyncServer from "@flows/sync/SyncServer"
import { Layer } from "effect"

const serverLayer = SyncServer.layer.pipe(
  Layer.provide(RunCatalog.layerStatic([]))
)
```

## Replay and cursors

`Read` pages durable entries until `done`; the client then subscribes using the latest cursors. A cursor is an exclusive `afterSeq` per run. Entries frames carry `fromSeq` and `toSeq` for the covered interval, not necessarily dense entry sequences. Journal admissions may leave holes in that interval.

If a frame starts after the covered cursor, `SyncClient` fails with terminal `SyncGapError`. It acknowledges a batch only after its entries have been materialized, then replenishes one credit. Transport failures retry by opening a new subscription; a `Closed` frame fails with `SyncError { code: "closed" }`.

The server currently emits one-entry `Entries` frames and does not use request credit or acknowledgements for backpressure. Those delivery controls are protocol fields, not an implemented server policy.

`RunCatalog` is a host port because journal has no exported workspace list/watch contract. See [the sync reference](../../docs/reference/sync.md).
