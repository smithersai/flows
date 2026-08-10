import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect, Layer, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

describe("Key", () => {
  const provideCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
    Effect.provide(effect, NodeCrypto.layer)
  const decode = (input: unknown): Keys.Key =>
    Effect.runSync(provideCrypto(Schema.decodeUnknownEffect(Keys.Key)(input)))

  it("derives the same key from canonically equivalent JSON", () => {
    expect(decode({ b: 2, a: 1 })).toBe(decode({ a: 1, b: 2 }))
  })

  it("keeps distinct JSON values distinct", () => {
    expect(decode({ value: 1 })).not.toBe(decode({ value: "1" }))
    expect(decode([1, 2])).not.toBe(decode([2, 1]))
  })

  it("produces a validated versioned key", () => {
    const key = decode({ operation: "compile", version: 1 })
    expect(Schema.decodeUnknownSync(Schema.toType(Keys.Key))(key)).toBe(key)
    expect(() => Schema.decodeUnknownSync(Schema.toType(Keys.Key))("key1_invalid")).toThrow()
  })

  it("reports non-canonicalizable inputs as schema errors", () => {
    const error = Effect.runSync(Effect.flip(provideCrypto(Schema.decodeUnknownEffect(Keys.Key)({ value: 1n }))))
    expect(error._tag).toBe("SchemaError")
  })

  it("reports crypto failures as schema errors", () => {
    const failingCrypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "Unknown",
            module: "test",
            method: "digest"
          }))
      })
    )
    const error = Effect.runSync(Effect.flip(Effect.provide(
      Schema.decodeUnknownEffect(Keys.Key)({ operation: "compile" }),
      failingCrypto
    )))
    expect(error._tag).toBe("SchemaError")
  })

  it("cannot reconstruct its input", () => {
    const key = decode({ operation: "compile" })
    expect(Effect.runSync(Effect.flip(Schema.encodeEffect(Keys.Key)(key)))._tag).toBe("SchemaError")
  })
})
