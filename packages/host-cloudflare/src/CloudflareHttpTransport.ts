/** Workers fetch transport. @since 0.1.0 */
import * as HttpTransport from "@flows/host/HttpTransport"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
const fromClient = Layer.effect(
  HttpTransport.HttpTransport,
  Effect.map(EffectHttpClient.HttpClient, (client) => HttpTransport.make(client.execute))
)
/** @category layers @since 0.1.0 */
export const layer = Layer.provide(
  fromClient,
  Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
)
