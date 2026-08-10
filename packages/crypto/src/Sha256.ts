import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"

/**
 * Validated lowercase hexadecimal SHA-256 digest.
 *
 * @private
 * @since 0.1.0
 */
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("flows/crypto/Sha256/Digest")
)

/**
 * Shared UTF-8 encoder for text inputs.
 *
 * @private
 * @since 0.1.0
 */
const encoder = new TextEncoder()

/**
 * One-way schema transformation from text or bytes to `Sha256.Digest`.
 *
 * Text is UTF-8 encoded and hashed with the injected Effect `Crypto` service;
 * the result is validated as 64 lowercase hexadecimal characters. Decoding
 * requires `Crypto`, and the digest cannot be encoded back into its source.
 *
 * @category transformations
 * @since 0.1.0
 */
export const Sha256 = Object.assign(
  Schema.Union([Schema.String, Schema.Uint8Array]).pipe(
    Schema.decodeTo(Digest, {
      decode: SchemaGetter.transformOrFail((input) =>
        Effect.gen(function*() {
          const crypto = yield* Crypto.Crypto
          const bytes = typeof input === "string" ? encoder.encode(input) : input
          const digest = yield* crypto.digest("SHA-256", bytes).pipe(
            Effect.mapError((error) => new SchemaIssue.InvalidValue(Option.some(input), { message: String(error) }))
          )
          return Encoding.encodeHex(digest)
        })
      ),
      encode: SchemaGetter.forbidden(() => "A digest cannot be converted back into its source bytes")
    })
  ),
  {
    /**
     * Schema for exactly 64 lowercase hexadecimal SHA-256 characters.
     *
     * @category models
     * @since 0.1.0
     */
    Digest
  }
)
