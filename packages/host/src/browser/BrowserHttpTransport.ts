/**
 * Browser single-hop HTTP transport.
 *
 * @since 0.1.0
 */
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpTransport from "../HttpTransport.ts"

const clientLayer = Layer.provide(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })
)

const fromClient: Layer.Layer<HttpTransport.HttpTransport, never, EffectHttpClient.HttpClient> = Layer.effect(
  HttpTransport.HttpTransport,
  Effect.map(EffectHttpClient.HttpClient, (client) => HttpTransport.make(client.execute))
)

/**
 * Provides a fetch-backed transport with redirect following disabled.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<HttpTransport.HttpTransport> = Layer.provide(fromClient, clientLayer)
