// Deep reviewed and polished by a human on 2026-08-10.

import { Canonical } from "@smthrs/canonical/Canonical"
import { Sha256 } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

/**
 * Validated storage representation of a key.
 *
 * @private
 * @since 0.1.0
 */
const KeyValue = Schema.String.check(Schema.isPattern(/^key1_[0-9a-f]{64}$/)).pipe(
  Schema.brand("flows/keys/Key")
)

/**
 * A versioned key encoded as `key1_` followed by a lowercase
 * hexadecimal SHA-256 digest.
 *
 * @category models
 * @since 0.1.0
 */
export type Key = typeof Key.Type

/**
 * One-way schema transformation from any canonical JSON value to a `Key`.
 *
 * The input is serialized with RFC 8785 canonical JSON and hashed through
 * the injected Effect `Crypto` service. Decoding therefore requires `Crypto`.
 * The key cannot be encoded back into the value that produced it.
 *
 * @category transformations
 * @since 0.1.0
 */
export const Key = Schema.Unknown.pipe(
  Schema.decodeTo(KeyValue, {
    decode: SchemaGetter.transformOrFail((input) =>
      Effect.gen(function*() {
        const serialized = yield* Schema.decodeUnknownEffect(Canonical)(input).pipe(
          Effect.mapError((error) => error.issue)
        )
        const digest = yield* Schema.decodeUnknownEffect(Sha256)(serialized).pipe(
          Effect.mapError((error) => error.issue)
        )
        return `key1_${digest}`
      })
    ),
    encode: SchemaGetter.forbidden(() => "A key cannot be converted back into its input")
  })
)
