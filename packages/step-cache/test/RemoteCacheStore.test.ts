/**
 * The dumb-HTTP action-cache protocol: `GET`/`PUT`/`DELETE /ac/{keyDigest}`,
 * mirroring `reference/bazel/.../remote/http/HttpCacheClient.java`.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as CacheStore from "../src/CacheStore.ts"
import * as RemoteCacheStore from "../src/RemoteCacheStore.ts"

const entry: CacheStore.CacheEntry = {
  keyDigest: "key-digest",
  result: { ok: true },
  meta: { tier: "sealed" },
  createdAtMs: 7,
  recordedRunId: "run-1",
  recordedEventSeq: 3
}

interface Call {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

const stubClient = (responder: (call: Call) => Response) => {
  const calls: Array<Call> = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const call: Call = {
        method: request.method,
        url: url.toString(),
        headers: { ...request.headers } as Record<string, string>,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      }
      calls.push(call)
      return HttpClientResponse.fromWeb(request, responder(call))
    })
  )
  return { calls, layer: Layer.succeed(HttpClient.HttpClient)(client) }
}

const tierOf = (responder: (call: Call) => Response, options?: RemoteCacheStore.Options) => {
  const stub = stubClient(responder)
  return {
    calls: stub.calls,
    store: Effect.provide(
      RemoteCacheStore.make(options ?? { endpoint: "https://cache.example.com/" }),
      stub.layer
    )
  }
}

const errorOf = (exit: Exit.Exit<unknown, unknown>): CacheStore.CacheStoreError => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: CacheStore.CacheStoreError }).error
}

describe("lookups", () => {
  it("GETs /ac/{keyDigest} and decodes the entry", async () => {
    const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }))
    const found = await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
    expect(Option.getOrUndefined(found)).toEqual(entry)
    expect(tier.calls[0]!.method).toBe("GET")
    expect(tier.calls[0]!.url).toBe("https://cache.example.com/ac/key-digest")
  })

  it("sends the configured credential headers", async () => {
    const tier = tierOf(() => new Response(JSON.stringify(entry), { status: 200 }), {
      endpoint: "https://cache.example.com",
      headers: { authorization: "Bearer secret" }
    })
    await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
    expect(tier.calls[0]!.headers["authorization"]).toBe("Bearer secret")
  })

  it("reports a miss on 404", async () => {
    const tier = tierOf(() => new Response(null, { status: 404 }))
    const found = await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)))
    expect(Option.isNone(found)).toBe(true)
  })

  it("refuses an empty key without a round trip", async () => {
    const tier = tierOf(() => new Response(null, { status: 200 }))
    const exit = await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.get("")).pipe(Effect.exit))
    expect(errorOf(exit).code).toBe("invalid_cache")
    expect(tier.calls).toEqual([])
  })

  it("fails on a non-2xx answer", async () => {
    const tier = tierOf(() => new Response(null, { status: 500 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("persistence_failed")
  })

  it("fails when the transport refuses", async () => {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") })
        })
      )
    )
    const store = Effect.provide(
      RemoteCacheStore.make({ endpoint: "https://cache.example.com" }),
      Layer.succeed(HttpClient.HttpClient)(client)
    )
    const exit = await Effect.runPromise(
      Effect.flatMap(store, (tier) => tier.get(entry.keyDigest)).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("persistence_failed")
  })

  it("fails on a body that is not JSON", async () => {
    const tier = tierOf(() => new Response("not json", { status: 200 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("persistence_failed")
  })

  it("fails on JSON that is not a cache entry", async () => {
    const tier = tierOf(() => new Response(JSON.stringify({ nope: 1 }), { status: 200 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("decode_failed")
  })

  it("refuses an entry recorded under a different key", async () => {
    // A tier that answers a lookup with someone else's entry would hand the
    // caller a result under the wrong key — the one thing content addressing
    // must never allow.
    const tier = tierOf(() => new Response(JSON.stringify({ ...entry, keyDigest: "other" }), { status: 200 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.get(entry.keyDigest)).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("decode_failed")
    expect(errorOf(exit).message).toContain("other")
  })
})

describe("publications", () => {
  it("PUTs the entry and reports Inserted on 201", async () => {
    const tier = tierOf(() => new Response(null, { status: 201 }))
    expect(await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.put(entry))))
      .toEqual({ _tag: "Inserted" })
    expect(tier.calls[0]!.method).toBe("PUT")
    expect(JSON.parse(tier.calls[0]!.body)).toEqual(entry)
  })

  it("reports ExistingSame on any other 2xx", async () => {
    const tier = tierOf(() => new Response(null, { status: 200 }))
    expect(await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.put(entry))))
      .toEqual({ _tag: "ExistingSame" })
  })

  it("reports Conflict on 409", async () => {
    const tier = tierOf(() => new Response(null, { status: 409 }))
    expect(await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.put(entry))))
      .toEqual({ _tag: "Conflict" })
  })

  it("fails on any other status", async () => {
    const tier = tierOf(() => new Response(null, { status: 500 }))
    const exit = await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.put(entry)).pipe(Effect.exit))
    expect(errorOf(exit).code).toBe("persistence_failed")
  })

  it("refuses an entry that violates the persistence contract", async () => {
    const tier = tierOf(() => new Response(null, { status: 201 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.put({ ...entry, createdAtMs: -1 })).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("invalid_cache")
    expect(tier.calls).toEqual([])
  })

  // BUG: RemoteCacheStore.put encodes `result`/`meta` as Schema.Unknown and then
  // serializes with bodyJsonUnsafe, so a BigInt or cyclic value escapes as a
  // JSON.stringify TypeError defect instead of a typed invalid_cache, and an
  // `undefined` value is silently published as a body with the field missing.
  it.fails("refuses a result or meta that has no JSON form, without a request or a defect", async () => {
    const cyclic: Record<string, unknown> = { name: "cycle" }
    cyclic["self"] = cyclic
    const malformed: ReadonlyArray<CacheStore.CacheEntry> = [
      { ...entry, result: undefined },
      { ...entry, result: BigInt(1) },
      { ...entry, result: cyclic },
      { ...entry, meta: undefined },
      { ...entry, meta: BigInt(1) },
      { ...entry, meta: cyclic }
    ]
    const tier = tierOf(() => new Response(null, { status: 201 }))
    const exits = await Effect.runPromise(
      Effect.forEach(
        malformed,
        (candidate) => Effect.flatMap(tier.store, (store) => store.put(candidate)).pipe(Effect.exit)
      )
    )

    // `CacheStore.put` already holds this line; the shared tier is the same
    // poisoning boundary and must not differ. A defect (`Die`) is the specific
    // outcome being ruled out: it escapes the typed error channel entirely.
    expect(exits.map((exit) => (Exit.isFailure(exit) ? exit.cause.reasons[0]!._tag : "Success"))).toEqual(
      malformed.map(() => "Fail")
    )
    expect(exits.map((exit) => errorOf(exit).code)).toEqual(malformed.map(() => "invalid_cache"))
    expect(tier.calls).toEqual([])
  })
})

describe("evictions", () => {
  it("DELETEs /ac/{keyDigest}", async () => {
    const tier = tierOf(() => new Response(null, { status: 204 }))
    expect(await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)))).toBe(true)
    expect(tier.calls[0]!.method).toBe("DELETE")
    expect(tier.calls[0]!.url).toBe("https://cache.example.com/ac/key-digest")
  })

  it("carries the provenance fence as query parameters", async () => {
    const tier = tierOf(() => new Response(null, { status: 200 }))
    await Effect.runPromise(
      Effect.flatMap(
        tier.store,
        (store) => store.evict(entry.keyDigest, { ifRecordedBy: { runId: "run-1", eventSeq: 3 } })
      )
    )
    expect(tier.calls[0]!.url).toContain("recordedRunId=run-1")
    expect(tier.calls[0]!.url).toContain("recordedEventSeq=3")
  })

  it("reports false on 404", async () => {
    const tier = tierOf(() => new Response(null, { status: 404 }))
    expect(await Effect.runPromise(Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)))).toBe(false)
  })

  it("fails on any other status", async () => {
    const tier = tierOf(() => new Response(null, { status: 500 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.evict(entry.keyDigest)).pipe(Effect.exit)
    )
    expect(errorOf(exit).code).toBe("persistence_failed")
  })

  // BUG: RemoteCacheStore.evict has no empty-key preflight, so `evict("")`
  // sends DELETE to the collection root `/ac/` instead of failing invalid_cache.
  it.fails("refuses an empty key without issuing a DELETE to the /ac/ root", async () => {
    // `get` already refuses an empty key without a round trip; `evict` is the
    // more dangerous half, because a malformed key targets a collection-like
    // endpoint with a destructive verb.
    const tier = tierOf(() => new Response(null, { status: 204 }))
    const exit = await Effect.runPromise(
      Effect.flatMap(tier.store, (store) => store.evict("")).pipe(Effect.exit)
    )
    // The request log is asserted first because it is the finding: today this
    // records a `DELETE https://cache.example.com/ac/`, the collection root.
    expect(tier.calls).toEqual([])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(errorOf(exit).code).toBe("invalid_cache")
  })
})

describe("layer", () => {
  it("provides the remote store under the CacheStore tag", async () => {
    const stub = stubClient(() => new Response(null, { status: 404 }))
    const found = await Effect.runPromise(
      Effect.flatMap(CacheStore.CacheStore, (store) => store.get(entry.keyDigest)).pipe(
        Effect.provide(
          RemoteCacheStore.layer({ endpoint: "https://cache.example.com" }).pipe(Layer.provide(stub.layer))
        )
      )
    )
    expect(Option.isNone(found)).toBe(true)
  })
})
