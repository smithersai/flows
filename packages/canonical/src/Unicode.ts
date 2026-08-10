// Deep reviewed and polished by a human on 2026-08-10.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** @private */
const Unicode = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
          return "Lone surrogate is not allowed"
        }
        index++
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return "Lone surrogate is not allowed"
      }
    }
    return true
  })
).pipe(Schema.brand("flows/canonical/Unicode"))

/**
 * Validates every string and property name in a JSON-like value.
 *
 * @private
 */
export const validateUnicode = (
  value: unknown,
  seen: WeakSet<object>
): Effect.Effect<void, Schema.SchemaError> =>
  Effect.gen(function*() {
    if (typeof value === "string") {
      yield* Schema.decodeUnknownEffect(Unicode)(value)
      return
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    for (const key of Object.keys(value)) {
      yield* Schema.decodeUnknownEffect(Unicode)(key)
      yield* validateUnicode((value as Record<string, unknown>)[key], seen)
    }
  })
