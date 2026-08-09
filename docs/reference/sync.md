# `@smthrs/sync`

This page is the public API reference for read-only journal synchronization over Effect RPC. The protocol currently supports catch-up and credit-bounded follow, not remote journal writes.

## `SyncProtocol`

| Export | Purpose |
| --- | --- |
| `WorkspaceScope`, `RunScope`, `Scope` | Replication selection schemas |
| `RunCursor`, `WorkspaceCursor` | Per-run and canonical cursor collection |
| `ReadRequest`, `ReadResponse` | Paged catch-up schemas |
| `SubscribeRequest` | Follow request with credit |
| `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, `Frame` | Stream frames |
| `covers(scope, runId)` | Scope predicate |

Cursor field names are `runId` and `afterSeq`.

## RPC group

`SyncRpcs.SyncRpcs` contains `Sync.Read` and streaming `Sync.Subscribe`. `SyncRpcs.SyncAuth` is the RPC middleware service for deployment-supplied authentication.

## Server

`SyncServer.Service` has `read(request)` and `subscribe(request)`. Exports include `SyncServer`, `make`, `makeNoop`, `layerNoop`, `makeLive`, and `layer`.

The live layer requires `Journal` and `RunCatalog`. `RunCatalog` exposes `list` and `changes`; constructors include `make`, `layerStatic`, `makeMemory`, and `layerNoop`.

## Client

`SyncClient.Sync` is the browser-safe service tag. Its service exposes:

- `subscribe({ scope, cursors })`, a stream of `JournalEvent.Entry`
- `cursors`, the locally admitted cursor set

`make({ client })` adapts an Effect RPC client; `layer` derives that client from `RpcClient.Protocol`. `makeNoop` and `layerNoop` provide a closed client.

The client advances its local cursor as each entry is admitted to the consumer, so interruption of a partial frame does not acknowledge entries that were never observed.

## Errors

`SyncError` has stable transport, authorization, request, and closure codes. `SyncGapError` reports a non-monotonic or inconsistent server interval.

See [Journal synchronization](../concepts/sync.md) and [Journal](../concepts/journal.md).

## Fan-out budgets

Subscription fan-out is covered by budget assertions, not only by frame assertions: `test/ServerSoak.test.ts` runs five concurrent workspace subscribers and requires an identical frame set from each, drains 200 subscribe/complete cycles and requires every per-run journal stream to be released afterwards, and soaks 200 five-subscriber rounds under a retained-heap budget. A regression that retains per-subscriber state passes every frame assertion in the other suites, so these are the tests that see it.
