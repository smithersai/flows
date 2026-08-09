# @smthrs/sync

Browser-safe, read-only replication of canonical `@smthrs/journal` entries.
It defines the wire protocol, RPC group, server, and replay-then-follow client;
journal mutation remains outside this package.

It also defines **branch collaboration**: a branch is one shared live document
whose durable state is exactly one journal run (`BranchProtocol.branchRunId`),
so multiplayer reuses the canonical `seq`, cursors, gap detection, and resumable
follow rather than introducing a second source of truth. Presence is a lease and
is never journalled; commands are admitted through a client-minted idempotency
key; every operation authorizes through a signed, expiring, branch-scoped share
capability.

```sh
npm install @smthrs/sync
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/sync/*` subpaths.

| Namespace          | Public exports                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncError`        | `ErrorCode` schema/type, general `SyncError` with guard `SyncError.is`, and terminal `SyncGapError`.                                                                                                                                                          |
| `SyncProtocol`     | Scope schemas `WorkspaceScope`, `RunScope`, and `Scope`; cursor schemas/types `RunCursor` and `WorkspaceCursor`; `ReadRequest`, `ReadResponse`, and `SubscribeRequest`; `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, and `Frame`; `covers(scope, runId)`. |
| `SyncRpcs`         | `SyncRpcs` defines `Sync.Read` and streaming `Sync.Subscribe`; `SyncAuth` is the RPC middleware service.                                                                                                                                                      |
| `RunCatalog`       | `RunCatalog` / `Service` list runs and expose changes. `make`, `layerStatic`, `makeMemory`, and `layerNoop` provide implementations.                                                                                                                          |
| `SyncServer`       | `SyncServer` / `Service`, `make`, `makeNoop`, and `layerNoop`; `makeLive` / `layer` implement journal replay and follow using `Journal` and `RunCatalog`.                                                                                                     |
| `SyncClient`       | `Sync` / `Service` expose `subscribe` and materialized `cursors`; `SubscribeOptions`, `make`, `makeNoop`, `layer`, and `layerNoop` construct the browser-safe client.                                                                                         |
| `BranchProtocol`   | `BranchId`, `ParticipantId`, `CommandId`, `Access`; `branchRunId` / `branchOfRunId` / `participantSourceId`; `CommandEvent` and `SayCommand`; `ShareClaims`, `ShareCapability`, `Cursor`, `Participant`, `CommandSubmission`, `CommandReceipt`.               |
| `BranchShare`      | `BranchShare` / `Service` with `mint` and `verify`; `AuthorizeRequest`, `MintRequest`, `make`, `makeNoop`, `layerNoop`, `makeHmac`, `layerHmac`.                                                                                                              |
| `BranchPresence`   | `BranchPresence` / `Service` with `announce`, `leave`, `list`, `changes`; `Announcement`, `RosterRequest`, `LeaveRequest`, `PresenceOptions`, `make`, `makeNoop`, `layerNoop`, `makeMemory`, `layer`.                                                         |
| `BranchCommands`   | `BranchCommands` / `Service` with `submit`; `SubmitRequest`, `submission`, `make`, `makeNoop`, `layerNoop`, `makeLive`, `layer`.                                                                                                                              |
| `BranchProjection` | `State`, `Message`, `AppliedCommand`, `Field`; `empty`, `apply`, `project`, and the explicit `resolveField` conflict policy.                                                                                                                                  |

Public test subpaths are `@smthrs/sync/test/TestSocket` (`FrameFilter`,
`TestFaults`, `Pair`, `makePair`) and `@smthrs/sync/test/TestSync`
(`layerTest`, `layerNoop`, `connect`).

```ts
import { RunCatalog, SyncServer } from "@smthrs/sync"
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
[sync concepts](../../docs/concepts/sync.md).
