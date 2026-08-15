import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Model from "../src/Model.ts"
import { ModelError } from "../src/ModelError.ts"

describe("ModelError", () => {
  it("round-trips all stable codes and classifies retryability", () => {
    const retryable = new Set(["rate_limited", "provider_internal", "transport"])
    const codes = [
      "invalid_request",
      "no_route",
      "authentication",
      "rate_limited",
      "quota_exceeded",
      "content_policy",
      "provider_internal",
      "transport",
      "invalid_provider_output",
      "unknown"
    ] as const
    for (const code of codes) {
      const error = new ModelError({
        code,
        message: code,
        retryAfterMillis: 10,
        resetAtEpochMillis: 123456789,
        resetSource: "header",
        providerCode: "code",
        requestId: "request",
        ...(code === "unknown" ? { httpStatus: 503 } : {})
      })
      expect(Schema.decodeUnknownSync(ModelError)(Schema.encodeSync(ModelError)(error))).toEqual(error)
      expect(error.retryable).toBe(retryable.has(code) || code === "unknown")
      expect(error.resetAtEpochMillis).toBe(123456789)
    }
    expect(new ModelError({ code: "quota_exceeded", message: "quota", httpStatus: 503 }).retryable).toBe(false)
  })
})

describe("Model", () => {
  it("resolves its noop layer through Effect.provide", async () => {
    const program = Effect.gen(function*() {
      return yield* Model.Model
    }).pipe(Effect.provide(Model.layerNoop()))
    const service = await Effect.runPromise(program)
    const exit = await Effect.runPromiseExit(Stream.runDrain(service.stream({
      modelId: "model",
      system: [],
      messages: [],
      tools: [],
      params: {}
    })))
    expect(exit._tag).toBe("Failure")
  })
})
