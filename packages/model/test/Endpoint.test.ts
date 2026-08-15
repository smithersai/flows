import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Endpoint from "../src/Endpoint.ts"

const make = (options: Endpoint.MakeOptions): Endpoint.Endpoint => Result.getOrThrow(Endpoint.make(options))

const failureMessage = (options: Endpoint.MakeOptions): string => {
  const result = Endpoint.make(options)
  expect(Result.isFailure(result)).toBe(true)
  return Result.isFailure(result) ? result.failure.message : ""
}

describe("Endpoint", () => {
  it("joins paths and renders sorted query pairs deterministically", () => {
    const endpoint = make({
      url: "https://example.test/v1/",
      path: "/responses",
      query: [["z", "last"], ["a", "two"], ["a", "one"]]
    })

    expect(endpoint).toEqual({
      method: "POST",
      url: "https://example.test/v1/responses",
      query: [["a", "one"], ["a", "two"], ["z", "last"]]
    })
    expect(Endpoint.render(endpoint)).toBe("https://example.test/v1/responses?a=one&a=two&z=last")
  })

  it("rejects embedded userinfo credentials", () => {
    expect(failureMessage({ url: "https://user:password@example.test" })).toMatch(/credentials/)
  })

  it("rejects credential-looking query parameters", () => {
    expect(failureMessage({ url: "https://example.test/?key=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test/?api_key=secret" })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: [["token", "secret"]] })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test", query: [["signature", "secret"]] })).toMatch(/credentials/)
    expect(failureMessage({ url: "https://example.test/?password=secret" })).toMatch(/credentials/)
  })
})
