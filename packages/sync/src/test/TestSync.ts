/**
 * In-process sync service and RPC transport wiring for tests.
 *
 * @since 0.1.0
 */
import { TestJournal } from "@flows/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Socket from "effect/unstable/socket/Socket"
import * as RunCatalog from "../RunCatalog.ts"
import * as SyncClient from "../SyncClient.ts"
import * as SyncRpcs from "../SyncRpcs.ts"
import * as SyncServer from "../SyncServer.ts"
import type { Pair } from "./TestSocket.ts"

const layerNoopAuth = Layer.succeed(SyncRpcs.SyncAuth)((effect) => effect)

/**
 * Provides the durable in-memory journal, a mutable empty run catalog, a
 * permissive authentication middleware, and the production sync server.
 *
 * Tests that need runs in the workspace may register them through their own
 * `RunCatalog.makeMemory` fixture before providing a more specific layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTest = SyncServer.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TestJournal.layer(),
      Layer.effect(RunCatalog.RunCatalog)(Effect.map(RunCatalog.makeMemory(), ({ catalog }) => catalog)),
      layerNoopAuth
    )
  )
)

/**
 * Provides no-op sync dependencies for consumers that only require the ports.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = Layer.mergeAll(
  SyncClient.layerNoop(),
  SyncServer.layerNoop,
  RunCatalog.layerNoop,
  layerNoopAuth
)

/**
 * Starts an RPC server over the pair's server endpoint and returns a sync
 * client over the client endpoint. JSON serialization is deliberately used so
 * frame faults can inspect test traffic without coupling to sync schemas.
 *
 * @category constructors
 * @since 0.1.0
 */
export const connect = (pair: Pair) =>
  Effect.gen(function*() {
    const sync = yield* SyncServer.SyncServer
    const serverSerialization = RpcSerialization.json.makeUnsafe()
    const serverWriter = yield* pair.server.writer
    const handlers = SyncRpcs.SyncRpcs.toLayer(
      Effect.succeed(
        SyncRpcs.SyncRpcs.of({
          "Sync.Read": (request) => sync.read(request),
          "Sync.Subscribe": (request) => sync.subscribe(request)
        })
      )
    )
    const server = yield* RpcServer.makeNoSerialization(SyncRpcs.SyncRpcs, {
      onFromServer: (response) => {
        const encoded = serverSerialization.encode(response)
        return encoded === undefined ? Effect.void : Effect.orDie(serverWriter(encoded))
      },
      disableFatalDefects: true
    }).pipe(Effect.provide(handlers))

    yield* pair.server.runRaw((bytes) => {
      const messages = serverSerialization.decode(bytes)
      return Effect.forEach(messages, (message) => server.write(0, message as never), { discard: true })
    }).pipe(Effect.forkScoped)

    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, pair.client),
      Effect.provide(RpcSerialization.layerJson)
    )
    const client = yield* RpcClient.make(SyncRpcs.SyncRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )
    return SyncClient.make({ client })
  })
