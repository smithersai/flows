# Journal synchronization

This page defines the current journal replication protocol in `@smthrs/sync-next`: cursor-based reads and credit-bounded subscriptions over Effect RPC. It does not describe bidirectional event writes.

## Scopes and cursors

A client reads either one run or every run in a workspace:

```ts
import { SyncProtocol } from "@smthrs/sync-next"
import { Schema } from "effect"

const scope = Schema.decodeUnknownSync(SyncProtocol.RunScope)({
  _tag: "Run",
  runId: "build-42"
})
const cursor = Schema.decodeUnknownSync(SyncProtocol.RunCursor)({
  runId: "build-42",
  afterSeq: 17
})
```

A run cursor stores the last observed sequence. A workspace cursor is an array of per-run cursors. Because journal sequences may have holes, a cursor means “read entries after this number,” not “expect the next number to be exactly one greater.”

## Read

`Sync.Read` accepts a scope, cursor, and limit and returns journal entries plus the next cursor. `RunCatalog` supplies the run list for workspace reads; `SyncServer.layer` combines it with `Journal`.

The server merges workspace entries deterministically. Consumers should persist the returned cursor only after applying the returned batch.

## Subscribe

`Sync.Subscribe` streams:

- `Entries` frames with events and the next cursor,
- `Heartbeat` frames when no entries arrive,
- one terminal `Closed` frame.

The request includes a credit count. Credit is a hard limit on frames emitted by that subscription, not a sliding acknowledgement window. There is currently no Ack RPC. A client that needs more data opens another subscription from the last durable cursor.

`SyncClient.subscribe` wraps the RPC stream and detects invalid cursor movement as `SyncGapError`. Transport, authentication, and reconnect policy remain application concerns.

## Authentication

`SyncAuth` is an Effect RPC middleware service. A deployment must provide its implementation at the transport boundary. The library defines the typed `SyncError`; it does not select an authentication scheme.

## Directionality

Current RPCs are read-only: `Read` and `Subscribe`. Client-to-server event submission, bidirectional reconciliation, acknowledgement windows, and resumable transport sessions are **Planned**.

See [Journal](journal.md) and the [`@smthrs/sync-next` reference](../reference/sync.md).
