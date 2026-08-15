import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"

describe("Auth", () => {
  it("signs Anthropic API-key headers", async () => {
    const auth = Auth.apiKeyHeader("x-api-key", Redacted.make("anthropic-secret"))
    await expect(Effect.runPromise(auth.sign({ accept: "application/json" }))).resolves.toEqual({
      accept: "application/json",
      "x-api-key": "anthropic-secret"
    })
  })

  it("signs OpenAI bearer headers", async () => {
    const auth = Auth.bearer(Redacted.make("openai-secret"))
    await expect(Effect.runPromise(auth.sign({}))).resolves.toEqual({ Authorization: "Bearer openai-secret" })
  })

  it("does not reveal credentials through the auth value", () => {
    const auth = Auth.bearer(Redacted.make("never-log-this"))
    expect(String(auth)).not.toContain("never-log-this")
    expect(JSON.stringify(auth)).not.toContain("never-log-this")
  })

  it("fails empty credentials as typed authentication errors", async () => {
    const error = await Effect.runPromise(Auth.bearer(Redacted.make("")).sign({}).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "authentication" })
  })
})
