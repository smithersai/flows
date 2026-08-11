/**
 * The shared artifact tier: an {@link ArtifactStore.Service} spoken over HTTP.
 *
 * The wire protocol mirrors Bazel's dumb-HTTP remote cache
 * (`reference/bazel/.../remote/http/HttpCacheClient.java`), which documents it
 * as: "CAS (Content Addressable Storage) blobs are stored under the path
 * `/cas/base16-key`", uploaded with `PUT`, downloaded with `GET`. We add
 * `HEAD /cas/{digest}` for a single existence probe and
 * `POST /cas/findMissing` for the batched one, because Bazel's HTTP client has
 * no `findMissingDigests` at all — it answers "everything is missing" and
 * re-uploads — and a batched probe is the whole reason
 * `MissingDigestsFinder` exists in the gRPC client.
 *
 * Transport is Effect's own `HttpClient` tag. There is no lower transport in
 * this repository, and there does not need to be one: the kernel already
 * decorates that tag with `net:get`/`net:post` capability checks, so a remote
 * artifact fetch is permission-checked like every other egress.
 *
 * The endpoint and its credentials arrive as **layer construction options**.
 * They are a capability, never an input: they are not hashed into a step key,
 * not journaled, and not part of any recorded result — see
 * `docs/specs/Specs/Input.md` ("secrets are never input") and
 * `docs/specs/Concepts/Remote Cache.md`.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ArtifactStore from "./ArtifactStore.ts"

/**
 * How to reach the shared artifact tier.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The cache root, e.g. `https://cache.example.com`. `/cas/{digest}` and
   * `/cas/findMissing` are resolved beneath it. A trailing slash is ignored.
   */
  readonly endpoint: string
  /**
   * Headers sent with every request — an `Authorization` bearer token, a
   * tenant header, whatever the deployment's gateway wants. This is the
   * credential seam, and it is deliberately construction-time: a credential
   * that arrived as a step input would be hashed into a step key and persisted
   * everywhere the journal goes.
   */
  readonly headers?: Record<string, string> | undefined
}

const transportFailure = (operation: string, cause: unknown): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `the remote artifact tier refused ${operation}: ${String(cause)}`,
    cause
  })

const unexpectedStatus = (operation: string, status: number): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "transport_failed",
    message: `the remote artifact tier answered ${operation} with HTTP ${status}`
  })

/** The batched-probe response body. */
const FindMissingResponse = Schema.Struct({ missing: Schema.Array(Schema.String) })

/**
 * A 2xx is success, a 404 is a miss, and everything else is a transport
 * failure. Bazel's HTTP client takes the same three-way split; it is the only
 * classification a dumb-HTTP cache can support, because there is no richer
 * error envelope on the wire.
 */
const isOk = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300

/**
 * Builds a remote artifact store over Effect's `HttpClient`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<ArtifactStore.Service, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const base = options.endpoint.replace(/\/+$/, "")
    const headers = options.headers
    const authorize = (request: HttpClientRequest.HttpClientRequest): HttpClientRequest.HttpClientRequest =>
      headers === undefined ? request : HttpClientRequest.setHeaders(request, headers)
    const casUrl = (digest: string) => `${base}/cas/${digest}`
    const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
      client.execute(authorize(request)).pipe(Effect.mapError((cause) => transportFailure(operation, cause)))
    const measure = (bytes: Uint8Array): Effect.Effect<ArtifactStore.Digest, never, Crypto.Crypto> =>
      Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)

    const put: ArtifactStore.Service["put"] = Effect.fn("RemoteArtifacts.put")((bytes: Uint8Array) =>
      Effect.gen(function*() {
        const digest = yield* measure(bytes)
        const response = yield* send(
          "an upload",
          HttpClientRequest.put(casUrl(digest)).pipe(
            HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream")
          )
        )
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("an upload", response.status))
        return digest
      })
    )

    const get: ArtifactStore.Service["get"] = Effect.fn("RemoteArtifacts.get")((digest: string) =>
      Effect.gen(function*() {
        const response = yield* send("a download", HttpClientRequest.get(casUrl(digest)))
        if (response.status === 404) {
          return yield* Effect.fail(new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest }))
        }
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("a download", response.status))
        const buffer = yield* response.arrayBuffer.pipe(
          Effect.mapError((cause) => transportFailure("a download body", cause))
        )
        const bytes = new Uint8Array(buffer)
        // The shared tier is the least trusted store there is: it is written
        // by machines this one has never met. Verifying the address here means
        // a mis-serving or compromised cache can waste a round trip but can
        // never substitute content.
        const measured = yield* measure(bytes)
        if (measured !== digest) {
          return yield* Effect.fail(
            new ArtifactStore.ArtifactCorruption({
              code: "artifact_corruption",
              recordedDigest: digest,
              measuredDigest: measured
            })
          )
        }
        return bytes
      })
    )

    const has: ArtifactStore.Service["has"] = Effect.fn("RemoteArtifacts.has")((digest: string) =>
      Effect.gen(function*() {
        const response = yield* send("an existence probe", HttpClientRequest.head(casUrl(digest)))
        if (response.status === 404) return false
        if (!isOk(response)) return yield* Effect.fail(unexpectedStatus("an existence probe", response.status))
        return true
      })
    )

    const findMissing: ArtifactStore.Service["findMissing"] = Effect.fn("RemoteArtifacts.findMissing")(
      (digests: Iterable<string>) =>
        Effect.gen(function*() {
          const requested = [...new Set(digests)]
          if (requested.length === 0) return []
          const response = yield* send(
            "a batched existence probe",
            HttpClientRequest.post(`${base}/cas/findMissing`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ digests: requested })
            )
          )
          if (!isOk(response)) {
            return yield* Effect.fail(unexpectedStatus("a batched existence probe", response.status))
          }
          const body = yield* response.json.pipe(
            Effect.mapError((cause) => transportFailure("a batched existence probe body", cause))
          )
          const decoded = yield* Schema.decodeUnknownEffect(FindMissingResponse)(body).pipe(
            Effect.mapError((cause) => transportFailure("a batched existence probe body", cause))
          )
          // "The returned set is guaranteed to be a subset of `digests`"
          // (`MissingDigestsFinder`). Bazel gets that from the server; we
          // enforce it on this side too, because a server that answered with
          // an unrequested digest would otherwise make the caller upload bytes
          // it never asked about.
          const asked = new Set(requested)
          return decoded.missing.filter((digest) => asked.has(digest))
        })
    )

    return { put, get, has, findMissing }
  })

/**
 * Provides a remote artifact store as the `ArtifactStore` tag.
 *
 * Composing this *alone* makes every artifact read and write a network round
 * trip. The intended production shape is
 * {@link CombinedArtifacts.layer | CombinedArtifacts}, with this as its remote
 * tier.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<ArtifactStore.ArtifactStore, never, HttpClient.HttpClient> =>
  Layer.effect(ArtifactStore.ArtifactStore)(make(options))
