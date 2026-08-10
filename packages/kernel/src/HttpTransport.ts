/**
 * The raw single-hop HTTP transport **port** at the Host boundary.
 *
 * This is the unguarded platform port. Its protected projection is
 * `./HttpClient.ts`; this tag is deliberately never republished as a guarded
 * kernel tag, because doing so would erase permission failures from its error
 * channel. The tag id `flows/host/HttpTransport` is FROZEN — it is digested
 * into step keys.
 *
 * Governing designs:
 * [Host Adapters](../../../docs/specs/Concepts/Host%20Adapters.md),
 * [Trust Granularity](../../../docs/specs/Concepts/Trust%20Granularity.md), and
 * [Effect Taxonomy](../../../docs/specs/Concepts/Effect%20Taxonomy.md).
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * A transport executes exactly one immutable request without following
 * redirects. Redirect handling belongs above the permission-aware client so
 * every target is checked independently.
 *
 * @category services
 * @since 0.1.0
 */
export interface HttpTransport {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
}

/**
 * The raw outgoing HTTP transport service.
 *
 * @category services
 * @since 0.1.0
 */
export const HttpTransport: Context.Service<HttpTransport, HttpTransport> = Context.Service(
  "flows/host/HttpTransport"
)

/**
 * Constructs a single-hop HTTP transport.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (execute: HttpTransport["execute"]): HttpTransport => HttpTransport.of({ execute })

/**
 * Constructs an unavailable transport stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<HttpTransport> = {}): HttpTransport =>
  HttpTransport.of({
    execute: (request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error("HTTP transport is unavailable on this host")
          })
        })
      ),
    ...overrides
  })

/**
 * Provides an unavailable transport stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<HttpTransport> = {}): Layer.Layer<HttpTransport> =>
  Layer.succeed(HttpTransport)(makeNoop(overrides))
