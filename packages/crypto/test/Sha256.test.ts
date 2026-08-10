// Deep reviewed and polished by a human.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect, Layer, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Sha256 } from "../src/index.ts"

const decode = (input: string | Uint8Array): typeof Sha256.Digest.Type =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(Effect.provide(NodeCrypto.layer))
  )

describe("Sha256", () => {
  it("hashes UTF-8 text and bytes identically", () => {
    expect(decode("hello")).toBe(decode(new TextEncoder().encode("hello")))
  })

  it("produces a validated lowercase digest", () => {
    const digest = decode("hello")
    expect(Schema.decodeUnknownSync(Sha256.Digest)(digest)).toBe(digest)
    expect(() => Schema.decodeUnknownSync(Sha256.Digest)("abc")).toThrow()
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
      Schema.decodeUnknownEffect(Sha256)("hello"),
      failingCrypto
    )))
    expect(error._tag).toBe("SchemaError")
  })

  it("cannot reconstruct its input", () => {
    const digest = decode("hello")
    expect(Effect.runSync(Effect.flip(Schema.encodeEffect(Sha256)(digest)))._tag).toBe("SchemaError")
  })
})
