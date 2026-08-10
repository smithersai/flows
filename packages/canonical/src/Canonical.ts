// Deep reviewed and polished by a human.

/**
 * RFC 8785 JSON canonicalization as an Effect.
 *
 * @since 0.1.0
 */
import canonicalize from "canonicalize"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const assertValidUnicode = (value: string): void => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Lone surrogate is not allowed")
      }
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Lone surrogate is not allowed")
    }
  }
}

const assertInputUnicode = (value: unknown, seen: WeakSet<object>): void => {
  if (typeof value === "string") {
    assertValidUnicode(value)
    return
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  for (const key of Object.keys(value)) {
    assertValidUnicode(key)
    assertInputUnicode((value as Record<string, unknown>)[key], seen)
  }
}

/**
 * JSON input could not be represented using RFC 8785.
 *
 * @since 0.1.0
 * @category errors
 */
export class CanonicalizeError extends Schema.TaggedErrorClass<CanonicalizeError>()(
  "@smthrs/canonical/CanonicalizeError",
  { cause: Schema.Unknown }
) {}

/**
 * Serializes a JSON value using RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * @since 0.1.0
 * @category serialization
 */
export const serialize = (value: unknown): Effect.Effect<string, CanonicalizeError> =>
  Effect.try({
    try: () => {
      assertInputUnicode(value, new WeakSet())
      const result = canonicalize(value)
      if (result === undefined) throw new TypeError("The value is not valid JSON")
      assertValidUnicode(result)
      JSON.parse(result)
      return result
    },
    catch: (cause) => new CanonicalizeError({ cause })
  })
