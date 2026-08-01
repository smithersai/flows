import * as HostHttpTransport from "@smithers/host/HttpTransport"
import { Effect } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import { GrantStore, type Service } from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import { PermissionDenied } from "../src/Permission.ts"

const itEffect = <E>(name: string, effect: () => Effect.Effect<void, E>) => it(name, () => Effect.runPromise(effect()))

const store = (checks: Array<Capability.Capability>, allowed = true) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return allowed
        ? Effect.void
        : Effect.fail(new PermissionDenied({ code: "permission_denied", capability, reason: "denied by test" }))
    },
    reply: () => Effect.die("not used by HTTP decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const transport = (calls: Array<string>) =>
  EffectHttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url)
      return { status: 200, headers: {}, request } as HttpClientResponse.HttpClientResponse
    })
  )

const protectedClient = <A, E, R>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  client: EffectHttpClient.HttpClient,
  grants: Service
) =>
  effect.pipe(
    Effect.provide(HttpClient.layer),
    Effect.provideService(HostHttpTransport.HttpTransport, HostHttpTransport.make(client.execute)),
    Effect.provideService(GrantStore, grants)
  )

describe("HttpClient", () => {
  itEffect("maps GET and HEAD to net:get and every other method to net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const
    return Effect.forEach(methods, (method) =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        yield* client.execute(HttpClientRequest.make(method)("https://example.test/path"))
      })).pipe(
        Effect.asVoid,
        (effect) => protectedClient(effect, transport(calls), store(checks)),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(checks.map((capability) => capability.action)).toEqual([
              "net:get",
              "net:get",
              "net:post",
              "net:post",
              "net:post",
              "net:post",
              "net:post",
              "net:post"
            ])
            expect(calls).toHaveLength(methods.length)
          })
        )
      )
  })

  itEffect("normalizes the URL host to lowercase and retains a nondefault port", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      yield* client.get("https://API.Example.Test:8443/v1")
      expect(checks).toEqual([{ action: "net:get", resource: "api.example.test:8443" }])
    }).pipe((effect) => protectedClient(effect, transport(calls), store(checks)))
  })

  itEffect("maps model execution to model:call without granting general net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      yield* client.executeModel(
        HttpClientRequest.post("https://API.Example.Test/v1/messages"),
        "anthropic/claude"
      )
      expect(checks).toEqual([
        { action: "model:call", resource: "api.example.test/anthropic/claude" }
      ])
      expect(calls).toEqual(["https://API.Example.Test/v1/messages"])
    }).pipe((effect) => protectedClient(effect, transport(calls), store(checks)))
  })

  itEffect("fails a relative or unparsable URL with a typed denial before transport", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("/relative"))
      expect(failure).toBeInstanceOf(PermissionDenied)
      expect(checks).toEqual([])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, transport(calls), store(checks)))
  })

  itEffect("does not delegate a denied request", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      yield* Effect.exit(client.post("https://example.test/write"))
      expect(checks).toEqual([{ action: "net:post", resource: "example.test" }])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, transport(calls), store(checks, false)))
  })

  itEffect("rechecks redirect targets when redirect following is composed above the protected client", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const redirects = EffectHttpClient.make((request) =>
      Effect.sync(() => {
        calls.push(request.url)
        return (request.url.includes("first")
          ? { status: 302, headers: { location: "https://second.test/next" }, request }
          : { status: 200, headers: {}, request }) as HttpClientResponse.HttpClientResponse
      })
    )
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const following = EffectHttpClient.followRedirects(client)
      yield* following.get("https://first.test/start")
      expect(checks).toEqual([
        { action: "net:get", resource: "first.test" },
        { action: "net:get", resource: "second.test" }
      ])
      expect(calls).toEqual(["https://first.test/start", "https://second.test/next"])
    }).pipe((effect) => protectedClient(effect, redirects, store(checks)))
  })
  itEffect("denies an unparsable model request as model:call, not net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const failure = yield* Effect.flip(
        client.executeModel(HttpClientRequest.post("/relative/messages"), "anthropic/claude")
      )
      expect(failure).toBeInstanceOf(PermissionDenied)
      expect((failure as PermissionDenied).capability).toMatchObject({ action: "model:call" })
      expect(checks).toEqual([])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, transport(calls), store(checks)))
  })

  itEffect("answers both stub entry points with the host transport failure", () => {
    const client = HttpClient.makeNoop()
    return Effect.gen(function*() {
      const executed = yield* Effect.flip(client.get("https://example.test/path"))
      const model = yield* Effect.flip(
        client.executeModel(HttpClientRequest.post("https://example.test/v1"), "anthropic/claude")
      )
      for (const failure of [executed, model]) {
        expect(String((failure as { readonly cause?: unknown }).cause)).toContain(
          "HTTP transport is unavailable on this host"
        )
      }
    })
  })

  itEffect("lets a stub override answer in place of the unavailable transport", () => {
    const overridden = HttpClient.makeNoop({
      executeModel: () => Effect.succeed({ status: 200, headers: {} } as HttpClientResponse.HttpClientResponse)
    })
    return Effect.gen(function*() {
      const response = yield* overridden.executeModel(
        HttpClientRequest.post("https://example.test/v1"),
        "anthropic/claude"
      )
      expect(response.status).toBe(200)
    })
  })
})
