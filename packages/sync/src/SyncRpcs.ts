/**
 * Schema-backed RPC projection of the sync read path.
 *
 * @since 0.1.0
 */
import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import { SyncError } from "./SyncError.ts"
import { Frame, ReadRequest, ReadResponse, SubscribeRequest } from "./SyncProtocol.ts"

/**
 * Authentication boundary for the sync RPC group.
 *
 * The middleware provides nothing: sync is a read path, and authorization is
 * expressed by rejecting the request rather than by narrowing a principal into
 * the handler.
 *
 * @category middleware
 * @since 0.1.0
 */
export class SyncAuth extends RpcMiddleware.Service<SyncAuth>()("@smithers/sync/SyncAuth", { error: SyncError }) {}

/**
 * The two remote procedures of the sync read path.
 *
 * A subscription's `credit` is a hard frame limit. Clients reconnect with
 * their materialized cursor to replenish it; there is no separate
 * acknowledgement channel.
 *
 * @category groups
 * @since 0.1.0
 */
export const SyncRpcs = RpcGroup.make(
  Rpc.make("Sync.Read", { payload: ReadRequest, success: ReadResponse, error: SyncError }),
  Rpc.make("Sync.Subscribe", { payload: SubscribeRequest, success: Frame, error: SyncError, stream: true })
).middleware(SyncAuth)
