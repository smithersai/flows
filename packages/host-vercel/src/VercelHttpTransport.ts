/** Fetch-backed single-hop HTTP transport for Vercel Edge. @since 0.1.0 */
import * as HttpTransport from "@flows/host/HttpTransport"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"

const clientLayer = Layer.provide(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" })
)

const fromClient: Layer.Layer<HttpTransport.HttpTransport, never, EffectHttpClient.HttpClient> = Layer.effect(
  HttpTransport.HttpTransport,
  Effect.map(EffectHttpClient.HttpClient, (client) => HttpTransport.make(client.execute))
)

/** Provides a fetch transport with redirects disabled. @category layers @since 0.1.0 */
export const layer: Layer.Layer<HttpTransport.HttpTransport> = Layer.provide(fromClient, clientLayer)
