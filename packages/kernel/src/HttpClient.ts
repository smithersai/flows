/**
 * Permission-aware outgoing HTTP requests.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */

import { make as makeCapability } from "@smthrs/capability/Capability"
import { PermissionDenied, type PermissionError } from "@smthrs/capability/Permission"
import { Context, Effect, Layer } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import type * as EffectHttpClientError from "effect/unstable/http/HttpClientError"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { GrantStore } from "./GrantStore.ts"
import * as HostHttpTransport from "./HttpTransport.ts"

/**
 * The error channel added by the capability kernel to HTTP requests.
 *
 * @category models
 * @since 0.1.0
 */
export type HttpClientError = EffectHttpClientError.HttpClientError | PermissionError

/**
 * An HTTP client whose requests have passed through the capability kernel.
 *
 * @category services
 * @since 0.1.0
 */
export type HttpClient =
  & EffectHttpClient.HttpClient.With<HttpClientError>
  & {
    readonly executeModel: (
      request: HttpClientRequest.HttpClientRequest,
      modelId: string
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError>
  }

/**
 * The permission-aware outgoing HTTP client service.
 *
 * @category services
 * @since 0.1.0
 */
export const HttpClient: Context.Service<HttpClient, HttpClient> = Context.Service("@smthrs/kernel/HttpClient")

/**
 * Constructs a permission-aware HTTP client from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (impl: HttpClient): HttpClient => HttpClient.of(impl)

/**
 * Constructs an unavailable permission-aware HTTP client stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<HttpClient> = {}): HttpClient => {
  const transport = HostHttpTransport.makeNoop()
  const client = EffectHttpClient.make(transport.execute)
  return make(Object.assign(client, {
    executeModel: Effect.fn("HttpClient.executeModel")(transport.execute)
  }, overrides))
}

/**
 * Provides an unavailable permission-aware HTTP client stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<HttpClient> = {}): Layer.Layer<HttpClient> =>
  Layer.succeed(HttpClient)(makeNoop(overrides))

const capabilityFor = (request: HttpClientRequest.HttpClientRequest, modelId?: string) => {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return Effect.fail(
      new PermissionDenied({
        code: "permission_denied",
        capability: makeCapability(
          modelId === undefined
            ? request.method === "GET" || request.method === "HEAD" ? "net:get" : "net:post"
            : "model:call",
          request.url
        ),
        reason: "HTTP capability checks require an absolute, parseable URL"
      })
    )
  }
  return Effect.succeed(
    modelId === undefined
      ? makeCapability(
        request.method === "GET" || request.method === "HEAD" ? "net:get" : "net:post",
        url.host.toLowerCase()
      )
      : makeCapability("model:call", `${url.host.toLowerCase()}/${modelId}`)
  )
}

/**
 * Decorates Effect's HTTP client with a pre-transport capability check.
 *
 * The dependency is a single-hop `HttpTransport`, not an opaque `HttpClient`,
 * so lower-layer redirects cannot bypass enforcement. `followRedirects`
 * composed above the protected client sends each redirected immutable request
 * through this guard.
 *
 * @category layers
 * @since 0.1.0
 */
const layerKernel: Layer.Layer<HttpClient, never, HostHttpTransport.HttpTransport | GrantStore> = Layer.effect(
  HttpClient,
  Effect.gen(function*() {
    const transport = yield* HostHttpTransport.HttpTransport
    const grants = yield* GrantStore
    const client = EffectHttpClient.makeWith<
      never,
      never,
      EffectHttpClientError.HttpClientError,
      never
    >(
      (request) => Effect.flatMap(request, transport.execute),
      (request) => Effect.succeed(request)
    )
    const guarded = EffectHttpClient.transform(
      client,
      (transport, request) =>
        Effect.flatMap(
          capabilityFor(request),
          (capability) => grants.check(capability).pipe(Effect.andThen(transport))
        )
    )
    return make(Object.assign(guarded, {
      executeModel: Effect.fn("HttpClient.executeModel")((
        request: HttpClientRequest.HttpClientRequest,
        modelId: string
      ) =>
        Effect.flatMap(
          capabilityFor(request, modelId),
          (capability) => grants.check(capability).pipe(Effect.andThen(transport.execute(request)))
        )
      )
    }))
  })
)

/**
 * Provides the permission-aware kernel HTTP tag.
 *
 * The raw host transport remains an input implementation detail and is not
 * republished under a narrower error contract. Consumers must use this tag so
 * permission failures remain visible and branchable.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<HttpClient, never, HostHttpTransport.HttpTransport | GrantStore> = layerKernel
