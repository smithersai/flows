// Deep reviewed and polished by a human on 2026-08-10.

/**
 * RFC 8785 canonical JSON: one document, one byte sequence.
 *
 * Everything `flows` digests goes through here first. A step key, a plan
 * digest, and a cache key are all hashes of JSON, so two structurally equal
 * values must serialize identically or the same work would key differently on
 * two hosts — property order, number formatting, and escaping all have to be
 * pinned, and RFC 8785 is the standard that pins them.
 *
 * The schema is a *decode*, not a formatter: it validates the value is
 * representable (no lone surrogates, no non-finite numbers, no cycles) and
 * fails with a schema issue when it is not, rather than emitting something
 * that would hash.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import { canonicalize } from "./internal/canonicalize.ts"
import { validateUnicode } from "./Unicode.ts"

/** @private */
const CanonicalString = Schema.String.pipe(
  Schema.brand("flows/canonical/Canonical")
)

/**
 * An RFC 8785 canonical JSON document.
 *
 * Branded, so a string that merely looks like JSON cannot be passed where a
 * canonical document is required — the brand is only obtainable by decoding
 * through {@link Canonical}.
 *
 * @category models
 * @since 0.1.0
 */
export type Canonical = typeof Canonical.Type

/**
 * Converts a JSON value into an RFC 8785 canonical JSON document.
 *
 * Decoding fails rather than approximates: a value carrying a lone surrogate,
 * a non-finite number, or a cycle has no canonical form, and emitting a
 * best-effort string for it would produce a digest that silently disagrees
 * with another host's. Encoding parses the document back into a plain value.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Canonical = Schema.Unknown.pipe(
  Schema.decodeTo(CanonicalString, {
    decode: SchemaGetter.transformOrFail((value, parseOptions) =>
      Effect.gen(function*() {
        yield* validateUnicode(value, new WeakSet()).pipe(
          Effect.mapError((error) => error.issue)
        )
        return yield* Effect.try({
          try: () => {
            const result = canonicalize(value)
            if (result === undefined) {
              throw new TypeError("The value is not valid JSON")
            }
            JSON.parse(result)
            return result
          },
          catch: (cause) =>
            new SchemaIssue.InvalidValue(
              { message: cause instanceof Error ? cause.message : String(cause) },
              value,
              parseOptions
            )
        })
      })
    ),
    encode: SchemaGetter.transform(
      (document) => JSON.parse(document) as unknown
    )
  })
)
