/**
 * The dumb-HTTP CAS protocol: `GET`/`PUT`/`HEAD /cas/{digest}` and
 * `POST /cas/findMissing`, mirroring
 * `reference/bazel/.../remote/http/HttpCacheClient.java`.
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as RemoteArtifacts from "../src/RemoteArtifacts.ts"
import { bytes, runPromise, sha256, text } from "./Crypto.ts"

const artifact = "a shared artifact"
const digest = sha256(bytes(artifact))

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** Records every request and answers it from a caller-supplied responder. */
const stubClient = (
  responder: (call: Call) => Response | Promise<Response>
) => {
  const calls: Array<Call> = []
  const client = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const body = request.body._tag === "Uint8Array" ? text(request.body.body)! : ""
      const call: Call = {
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers } as Record<string, string>,
        body
      }
      calls.push(call)
      return HttpClientResponse.fromWeb(request, await responder(call))
    })
  )
  return { calls, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const remote = (
  responder: (call: Call) => Response | Promise<Response>,
  options?: Omit<RemoteArtifacts.Options, "endpoint"> & { readonly endpoint?: string }
) => {
  const stub = stubClient(responder)
  return {
    calls: stub.calls,
    store: Effect.provide(
      RemoteArtifacts.make({ endpoint: options?.endpoint ?? "https://cache.example.com/", ...options }),
      stub.layer
    )
  }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("uploads", () => {
  it("PUTs the bytes to /cas/{digest} and returns the measured address", async () => {
    const tier = remote(() => new Response(null, { status: 201 }))
    const published = await runPromise(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
    expect(published).toBe(digest)
    expect(tier.calls[0]!.method).toBe("PUT")
    // The trailing slash on the configured endpoint is ignored.
    expect(tier.calls[0]!.url).toBe(`https://cache.example.com/cas/${digest}`)
    expect(tier.calls[0]!.body).toBe(artifact)
  })

  it("sends the configured credential headers", async () => {
    const tier = remote(() => new Response(null, { status: 200 }), { headers: { authorization: "Bearer secret" } })
    await runPromise(Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))))
    expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer secret")
  })

  it("fails on a non-2xx answer", async () => {
    const tier = remote(() => new Response(null, { status: 500 }))
    const exit = await runPromise(
      Effect.flatMap(tier.store, (store) => store.put(bytes(artifact))).pipe(Effect.exit)
    )
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })

  it("fails when the transport itself refuses", async () => {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") })
        })
      )
    )
    const store = Effect.provide(
      RemoteArtifacts.make({ endpoint: "https://cache.example.com" }),
      Layer.succeed(HttpClient.HttpClient)(client)
    )
    const exit = await runPromise(Effect.flatMap(store, (tier) => tier.put(bytes(artifact))).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })
})

describe("downloads", () => {
  it("GETs /cas/{digest} and verifies the address", async () => {
    const tier = remote(() => new Response(artifact))
    expect(text(await runPromise(Effect.flatMap(tier.store, (store) => store.get(digest))))).toBe(artifact)
    expect(tier.calls[0]!.method).toBe("GET")
  })

  it("reports a typed miss on 404", async () => {
    const tier = remote(() => new Response(null, { status: 404 }))
    const exit = await runPromise(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts-next/ArtifactMissing")
  })

  it("refuses content that does not hash to the requested address", async () => {
    // The shared tier is the least trusted store there is: a mis-serving or
    // compromised cache must never be able to substitute content.
    const tier = remote(() => new Response("something else entirely"))
    const exit = await runPromise(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
    const failure = errorOf(exit) as ArtifactStore.ArtifactCorruption
    expect(failure._tag).toBe("@smthrs/artifacts-next/ArtifactCorruption")
    expect(failure.recordedDigest).toBe(digest)
  })

  it("fails on a non-2xx answer", async () => {
    const tier = remote(() => new Response(null, { status: 503 }))
    const exit = await runPromise(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })

  it("fails when the response body cannot be read", async () => {
    const tier = remote(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("truncated"))
          }
        })
      )
    )
    const exit = await runPromise(Effect.flatMap(tier.store, (store) => store.get(digest)).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })
})

describe("existence probes", () => {
  it("HEADs /cas/{digest}", async () => {
    const tier = remote(() => new Response(null, { status: 200 }))
    expect(await runPromise(Effect.flatMap(tier.store, (store) => store.has(digest)))).toBe(true)
    expect(tier.calls[0]!.method).toBe("HEAD")
  })

  it("answers false on 404", async () => {
    const tier = remote(() => new Response(null, { status: 404 }))
    expect(await runPromise(Effect.flatMap(tier.store, (store) => store.has(digest)))).toBe(false)
  })

  it("fails on any other status", async () => {
    const tier = remote(() => new Response(null, { status: 403 }))
    const exit = await runPromise(Effect.flatMap(tier.store, (store) => store.has(digest)).pipe(Effect.exit))
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })
})

describe("the batched probe", () => {
  const other = sha256(bytes("another artifact"))

  it("POSTs /cas/findMissing and returns what the tier reported", async () => {
    const tier = remote(() => new Response(JSON.stringify({ missing: [other] }), { status: 200 }))
    expect(await runPromise(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other, other]))))
      .toEqual([other])
    expect(tier.calls[0]!.method).toBe("POST")
    expect(tier.calls[0]!.url).toBe("https://cache.example.com/cas/findMissing")
    // Duplicates never reach the wire.
    expect(JSON.parse(tier.calls[0]!.body)).toEqual({ digests: [digest, other] })
  })

  it("never asks about nothing", async () => {
    const tier = remote(() => new Response(null, { status: 500 }))
    expect(await runPromise(Effect.flatMap(tier.store, (store) => store.findMissing([])))).toEqual([])
    expect(tier.calls).toEqual([])
  })

  it("drops digests the caller never asked about", async () => {
    // "The returned set is guaranteed to be a subset of `digests`"
    // (`MissingDigestsFinder`). A server that answered otherwise would make
    // the caller upload bytes it never probed for.
    const tier = remote(() => new Response(JSON.stringify({ missing: [other, "unrequested"] }), { status: 200 }))
    expect(await runPromise(Effect.flatMap(tier.store, (store) => store.findMissing([digest, other]))))
      .toEqual([other])
  })

  it("fails on a non-2xx answer", async () => {
    const tier = remote(() => new Response(null, { status: 502 }))
    const exit = await runPromise(
      Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
    )
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })

  it("fails on a body that is not JSON", async () => {
    const tier = remote(() => new Response("not json at all", { status: 200 }))
    const exit = await runPromise(
      Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
    )
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })

  it("fails on JSON that is not a findMissing answer", async () => {
    const tier = remote(() => new Response(JSON.stringify({ absent: [] }), { status: 200 }))
    const exit = await runPromise(
      Effect.flatMap(tier.store, (store) => store.findMissing([digest])).pipe(Effect.exit)
    )
    expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("transport_failed")
  })
})

describe("the address guard", () => {
  // A digest reaches a read straight out of a durable row, so it is untrusted
  // input, and here it is interpolated into a URL path. An address carrying a
  // separator or a `..` would point this client at a different resource on the
  // configured endpoint — so it is refused before any request goes out, by the
  // same guard the filesystem tier applies.
  const unusable = ["", "../ac/other-key", "sub/dir", "..", "back\\slash"]
  for (const digest of unusable) {
    it(`refuses ${JSON.stringify(digest)} without a round trip`, async () => {
      const tier = remote(() => new Response(null, { status: 200 }))
      const store = await runPromise(tier.store)
      const refused = async (operation: Effect.Effect<unknown, unknown, Crypto.Crypto>) =>
        (errorOf(await runPromise(operation.pipe(Effect.exit))) as ArtifactStore.ArtifactStoreError).code
      expect(await refused(store.get(digest))).toBe("invalid_digest")
      expect(await refused(store.has(digest))).toBe("invalid_digest")
      expect(await refused(store.findMissing([digest]))).toBe("invalid_digest")
      expect(tier.calls).toEqual([])
    })
  }
})

describe("layer", () => {
  it("provides the remote store under the ArtifactStore tag", async () => {
    const stub = stubClient(() => new Response(null, { status: 201 }))
    const published = await runPromise(
      Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.put(bytes(artifact))).pipe(
        Effect.provide(
          RemoteArtifacts.layer({ endpoint: "https://cache.example.com" }).pipe(Layer.provide(stub.layer))
        )
      )
    )
    expect(published).toBe(digest)
  })
})
