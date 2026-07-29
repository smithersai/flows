/**
 * Node.js single-hop HTTP transport.
 *
 * @since 0.1.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpTransport from "../HttpTransport.ts"

const fromClient: Layer.Layer<HttpTransport.HttpTransport, never, EffectHttpClient.HttpClient> = Layer.effect(
  HttpTransport.HttpTransport,
  Effect.map(EffectHttpClient.HttpClient, (client) => HttpTransport.make(client.execute))
)

/**
 * Provides an Undici-backed transport. Undici does not follow redirects unless
 * a redirect interceptor is installed, preserving the single-hop contract.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<HttpTransport.HttpTransport> = Layer.provide(
  fromClient,
  NodeHttpClient.layerUndici
)
