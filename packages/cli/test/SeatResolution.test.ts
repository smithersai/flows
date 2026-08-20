/**
 * The complete seat-resolution matrix: every supported provider crossed with
 * every state its API key variable can be in, plus the seat-string shapes the
 * parser has to separate — bare, prefixed, trailing-separator, and multiply
 * separated.
 *
 * The resolver is the agent's front door: a seat that resolves wrong routes a
 * run to the wrong provider, and a seat that fails to resolve must say which
 * variable to set.
 */
import { Seat } from "@smthrs/agent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const executor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("model transport was not expected"))
})

const resolve = (
  environment: Readonly<Record<string, string | undefined>>,
  seat: string
) => Effect.scoped(NodeControl.seatResolver(environment, executor).resolve(seat))

const keyed = {
  ANTHROPIC_API_KEY: "anthropic-key",
  OPENAI_API_KEY: "openai-key",
  OPENROUTER_API_KEY: "openrouter-key"
}

const prepared = (seat: Seat.Seat, modelId: string) =>
  Effect.runPromise(
    seat.route.prepare({
      modelId,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      params: {}
    } as never)
  )

describe("NodeControl.seatResolver providers", () => {
  it.each(
    [
      ["anthropic", "anthropic:claude-sonnet-4-5", "https://api.anthropic.com/v1/messages", 200_000],
      ["openai", "openai:gpt-5.6-sol", "https://api.openai.com/v1/responses", 400_000],
      ["openrouter", "openrouter:openai/gpt-5.6-sol", "https://openrouter.ai/api/v1/responses", 400_000]
    ] as const
  )("routes a keyed %s seat to its own endpoint", async (_provider, seat, url, tokens) => {
    const resolved = await Effect.runPromise(resolve(keyed, seat))

    expect(resolved.id).toBe(seat)
    expect(resolved.contextWindowTokens).toBe(tokens)
    const request = await prepared(resolved, Seat.modelIdOf(seat))
    expect(request.url).toBe(url)
    // The credential is applied by Auth as the request leaves; it never enters
    // the sealed, credential-free view.
    expect(JSON.stringify(request.publicHeaders)).not.toContain("key")
  })

  it("routes a seat with no separator through Anthropic as a bare model id", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "claude-opus-4-1"))

    // The one provider convention this host assumes: no prefix means Anthropic.
    expect(resolved.id).toBe("claude-opus-4-1")
    expect(resolved.contextWindowTokens).toBe(200_000)
    expect((await prepared(resolved, "claude-opus-4-1")).url).toBe("https://api.anthropic.com/v1/messages")
  })

  it("keeps every separator after the first inside the model id", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "openrouter:anthropic/claude:beta"))

    // OpenRouter spells vendor and model with a slash, and a colon in a model
    // id belongs to the model, not to another provider prefix.
    expect(Seat.modelIdOf("openrouter:anthropic/claude:beta")).toBe("anthropic/claude:beta")
    expect(resolved.contextWindowTokens).toBe(200_000)
  })

  it("resolves a seat that is nothing but a provider prefix", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "openai:"))

    // A trailing separator is an empty model id, which no catalog pattern
    // matches, so the conservative floor applies rather than zero.
    expect(resolved.id).toBe("openai:")
    expect(resolved.contextWindowTokens).toBe(128_000)
  })

  it("gives a model the catalog has never met the conservative floor", async () => {
    const resolved = await Effect.runPromise(resolve(keyed, "anthropic:some-unreleased-model"))

    expect(resolved.contextWindowTokens).toBe(128_000)
  })

  it("refuses a provider prefix that names no route", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, "mystery:model-x")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
    expect(error.seat).toBe("mystery:model-x")
    expect(error.message).toBe("No route is configured for the mystery provider")
  })

  it("refuses an empty provider prefix rather than defaulting it", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve(keyed, ":claude-sonnet-4-5")))

    // A leading separator is an explicit empty provider, which is not the same
    // as no separator at all.
    expect(error.message).toBe("No route is configured for the  provider")
  })

  it("refuses the empty seat", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({}, "")))

    // No separator, so the Anthropic route applies and the missing key is what
    // the operator hears about.
    expect(error.message).toBe("Set ANTHROPIC_API_KEY to run the  seat")
  })
})

describe("NodeControl.seatResolver credentials", () => {
  it.each(
    [
      ["anthropic", "anthropic:claude-sonnet-4-5", "ANTHROPIC_API_KEY"],
      ["openai", "openai:gpt-5.6-sol", "OPENAI_API_KEY"],
      ["openrouter", "openrouter:openai/gpt-5.6-sol", "OPENROUTER_API_KEY"],
      ["a bare model id", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"]
    ] as const
  )("refuses %s with its key variable absent and with it empty, naming the variable", async (
    _provider,
    seat,
    variable
  ) => {
    const absent = await Effect.runPromise(Effect.flip(resolve({}, seat)))
    const empty = await Effect.runPromise(Effect.flip(resolve({ [variable]: "" }, seat)))

    // An empty string is treated exactly like an unset variable: a blank key
    // would otherwise reach the provider and fail as an opaque 401.
    expect(absent.message).toBe(`Set ${variable} to run the ${seat} seat`)
    expect(empty.message).toBe(absent.message)
    expect(absent.seat).toBe(seat)
  })

  it("reads only the variable its own provider owns", async () => {
    const wrongKey = await Effect.runPromise(Effect.flip(resolve({ OPENAI_API_KEY: "k" }, "anthropic:claude-3")))
    const rightKey = await Effect.runPromise(resolve({ ANTHROPIC_API_KEY: "k" }, "anthropic:claude-3"))

    expect(wrongKey.message).toBe("Set ANTHROPIC_API_KEY to run the anthropic:claude-3 seat")
    expect(rightKey.id).toBe("anthropic:claude-3")
  })

  it("accepts a single-character key as present", async () => {
    const resolved = await Effect.runPromise(resolve({ OPENAI_API_KEY: "k" }, "openai:gpt-5.6-sol"))

    // Length one is the boundary of the `length === 0` refusal.
    expect(resolved.id).toBe("openai:gpt-5.6-sol")
  })

  it("refuses a keyed provider when the environment record is empty", async () => {
    const error = await Effect.runPromise(Effect.flip(resolve({}, "openrouter:openai/gpt-5.6-sol")))

    expect(error).toBeInstanceOf(Seat.SeatUnresolved)
  })
})
