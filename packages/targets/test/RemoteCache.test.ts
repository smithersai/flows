import { describe, expect, it } from "vitest"
import * as RemoteCache from "../src/RemoteCache.ts"
import { Secret } from "../src/Secret.ts"

describe("RemoteCache.make", () => {
  it("defaults the declared secret and stays inert", () => {
    const declaration = RemoteCache.make({ endpoint: "https://cache.example.test/" })
    expect(declaration.endpoint).toBe("https://cache.example.test")
    expect(declaration.token).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_TOKEN" })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
  })

  it("accepts a declared secret naming another variable", () => {
    expect(RemoteCache.make({
      endpoint: "https://cache.example.test/base/",
      token: Secret("PROJECT_CACHE_TOKEN")
    })).toMatchObject({
      endpoint: "https://cache.example.test/base",
      token: { _tag: "Secret", env: "PROJECT_CACHE_TOKEN" }
    })
  })

  it("refuses a bare string where a declaration belongs", () => {
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: "SMITHERS_CACHE_TOKEN" as never
      })
    ).toThrow(/must be a Secret declaration/)
  })

  it("requires an HTTPS endpoint without embedded credentials", () => {
    expect(() => RemoteCache.make({ endpoint: "http://cache.example.test" })).toThrow(/use HTTPS/)
    expect(() => RemoteCache.make({ endpoint: "cache.example.test" })).toThrow(/absolute HTTPS URL/)
    expect(() => RemoteCache.make({ endpoint: "https://token@cache.example.test" })).toThrow(/credentials/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test?token=secret" })).toThrow(/query/)
  })

  it("bounds endpoint text before URL parsing", () => {
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test\n" })).toThrow(/control characters/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test/\ud800" })).toThrow(/well-formed/)
    expect(() =>
      RemoteCache.make({ endpoint: `https://cache.example.test/${"x".repeat(RemoteCache.maximumEndpointBytes)}` })
    )
      .toThrow(/bounded/)
  })

  it("requires a valid non-reserved token variable name", () => {
    expect(() => Secret("not valid")).toThrow(/environment variable name/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", token: Secret("SMITHERS_CACHE_URL") }))
      .toThrow(/must not be SMITHERS_CACHE_URL/)
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: Secret(`A${"B".repeat(RemoteCache.maximumTokenEnvironmentLength)}`)
      })
    ).toThrow(/bounded/)
  })

  it("rejects malformed option bags and hostile declarations without invoking accessors", () => {
    let invoked = false
    const options = Object.defineProperty({}, "endpoint", {
      enumerable: true,
      get: () => {
        invoked = true
        return "https://cache.example.test"
      }
    })
    expect(() => RemoteCache.make(options as never)).toThrow(/data property/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", typo: true } as never))
      .toThrow(/unknown option/)

    const declaration = Object.defineProperty({}, RemoteCache.TypeId, {
      get: () => {
        invoked = true
        return RemoteCache.TypeId
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(false)
    expect(RemoteCache.isRemoteCache(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })
})
