/**
 * Transport-neutral application composition.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type { Control } from "@smthrs/control"
import { ControlClient, ControlLive, ControlRuntime } from "@smthrs/control"
import type { Journal } from "@smthrs/journal-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Layer } from "effect"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import type { RpcSerialization } from "effect/unstable/rpc/RpcSerialization"
import type { Socket } from "effect/unstable/socket/Socket"

/**
 * Configuration parsed before the command handlers are run.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  readonly remote?: string | undefined
}

/**
 * The runtime and journal a local composition executes on.
 *
 * A journal is required, not optional: `Journal.layerNoop()` is a closed stub,
 * so every mutation event (decide/pause/resume/launch) failed with
 * `journal_closed` after the runtime had already transitioned.
 *
 * @category models
 * @since 0.1.0
 */
export interface Engine {
  readonly runtime: Layer.Layer<ControlRuntime.ControlRuntime>
  readonly journal: Layer.Layer<Journal.Journal>
}

/**
 * The in-memory engine: a deterministic runtime over an in-memory SQLite
 * journal.
 *
 * It is the default because this module is transport-neutral and cannot open a
 * file. Nothing it records survives the process, so a platform composition
 * that can reach durable storage should supply its own —
 * `NodeControl.engineDurable` is the Node one.
 *
 * A local journal that fails to migrate cannot serve anything; startup failure
 * is a defect, not a typed control-plane error.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineMemory: Engine = {
  // The runtime mints identifiers through `Crypto`, which is a host service
  // now rather than an ambient global.
  runtime: ControlRuntime.layerMemory().pipe(Layer.provide(NodeCrypto.layer)),
  journal: TestJournal.layer().pipe(Layer.orDie)
}

const layerLocal = (registry: Layer.Layer<Registry.Registry>, engine: Engine) =>
  ControlLive.layer.pipe(
    Layer.provide([
      engine.runtime,
      engine.journal,
      // The real queue, over the same journal the control plane writes to.
      // `layerNoop` dropped every notification on the floor.
      NotificationQueue.layer.pipe(Layer.provide(engine.journal)),
      registry
    ])
  )

const rpcUrl = (remote: string): string => {
  const url = new URL(remote)
  if (!url.pathname.endsWith("/rpc")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/rpc`
  }
  return url.toString()
}

/**
 * Selects the sole Control implementation used by the command tree.
 *
 * Local commands call the in-process implementation directly. Remote commands
 * use the RPC-backed implementation and leave its abstract HTTP and socket
 * requirements for a platform composition module to provide.
 *
 * `registry` is the local flow registry and `engine` is what local commands
 * execute on. This module is transport-neutral, so it can construct neither a
 * filesystem-backed registry nor a file-backed engine and defaults to the empty
 * registry and the in-memory engine; a platform composition supplies the real
 * things — `NodeControl.layerRegistry` and `NodeControl.engineDurable` are the
 * Node ones.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  config: Config,
  registry: Layer.Layer<Registry.Registry> = Registry.layerNoop(),
  engine: Engine = engineMemory
): Layer.Layer<Control.Control, never, HttpClient | RpcSerialization | Socket> =>
  config.remote === undefined ? layerLocal(registry, engine) : ControlClient.layer({ url: rpcUrl(config.remote) })
