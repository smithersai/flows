import * as HostHttpTransport from "@smithers/host/HttpTransport"
import { Effect } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { describe, expect, it } from "vitest"
import type * as Capability from "../src/Capability.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import { PermissionDenied } from "../src/Permission.ts"

/**
 * A request whose URL cannot be parsed has no host, so there is no honest
 * capability resource to ask about. The kernel fails closed — but the denial it
 * reports still has to name the action the caller attempted, otherwise the
 * audit record and the operator's error message describe the wrong effect tier.
 */

const itEffect = <E>(name: string, effect: () => Effect.Effect<void, E>) => it(name, () => Effect.runPromise(effect()))

const store = (checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return Effect.void
    },
    reply: () => Effect.die("not used by HTTP decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const provide = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  calls: Array<string>,
  checks: Array<Capability.Capability>
) =>
  effect.pipe(
    Effect.provide(HttpClient.layer),
    Effect.provideService(
      HostHttpTransport.HttpTransport,
      HostHttpTransport.make((request) =>
        Effect.sync(() => {
          calls.push(request.url)
          return { status: 200, headers: {}, request } as never
        })
      )
    ),
    Effect.provideService(GrantStore, store(checks))
  )

const unparsable = "not a url"

describe("HttpClient unparsable URLs", () => {
  itEffect("names net:get for a rejected GET", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const failure = yield* Effect.flip(client.execute(HttpClientRequest.get(unparsable)))
        expect(failure).toBeInstanceOf(PermissionDenied)
        expect(failure).toMatchObject({
          capability: { action: "net:get", resource: unparsable },
          reason: "HTTP capability checks require an absolute, parseable URL"
        })
        expect(checks).toEqual([])
        expect(calls).toEqual([])
      }),
      calls,
      checks
    )
  })

  itEffect("names net:get for a rejected HEAD", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const failure = yield* Effect.flip(client.head(unparsable))
        expect(failure).toMatchObject({ capability: { action: "net:get" } })
      }),
      calls,
      checks
    )
  })

  itEffect("names net:post for a rejected write method", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const failure = yield* Effect.flip(client.execute(HttpClientRequest.make("DELETE")(unparsable)))
        expect(failure).toMatchObject({ capability: { action: "net:post", resource: unparsable } })
        expect(calls).toEqual([])
      }),
      calls,
      checks
    )
  })

  itEffect("names model:call for a rejected model request regardless of method", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const failure = yield* Effect.flip(
          client.executeModel(HttpClientRequest.get(unparsable), "anthropic/claude")
        )
        expect(failure).toMatchObject({ capability: { action: "model:call", resource: unparsable } })
        expect(checks).toEqual([])
        expect(calls).toEqual([])
      }),
      calls,
      checks
    )
  })
})

describe("HttpClient stub layer", () => {
  itEffect("provides an unavailable client", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      expect(yield* Effect.flip(client.get("https://example.test"))).toBeDefined()
    }).pipe(Effect.provide(HttpClient.layerNoop())))

  itEffect("provides overridden model execution while plain requests stay unavailable", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      expect(yield* client.executeModel(HttpClientRequest.get("https://example.test"), "m"))
        .toMatchObject({ status: 299 })
      expect(yield* Effect.flip(client.get("https://example.test"))).toBeDefined()
    }).pipe(
      Effect.provide(
        HttpClient.layerNoop({
          executeModel: () => Effect.succeed({ status: 299 } as never)
        })
      )
    ))

  it("builds a stub client directly", () => {
    const stub = HttpClient.makeNoop()
    expect(typeof stub.executeModel).toBe("function")
    expect(HttpClient.make(stub)).toStrictEqual(stub)
  })
})

describe("HttpClient redirects", () => {
  itEffect("re-checks each redirected request against the kernel", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      yield* client.get("https://first.test/a")
      yield* client.get("https://second.test/b")
      expect(checks.map((check) => check.resource)).toEqual(["first.test", "second.test"])
      expect(calls).toEqual(["https://first.test/a", "https://second.test/b"])
    }).pipe((effect) => provide(effect, calls, checks))
  })
})
