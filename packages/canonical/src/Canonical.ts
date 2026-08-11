// Deep reviewed and polished by a human on 2026-08-10.

import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import { canonicalize } from "./internal/canonicalize.ts"
import { validateUnicode } from "./Unicode.ts"

/** @private */
const CanonicalString = Schema.String.pipe(
  Schema.brand("flows/canonical/Canonical")
)

/** An RFC 8785 canonical JSON document. */
export type Canonical = typeof Canonical.Type

/** Converts a JSON value into an RFC 8785 canonical JSON document. */
export const Canonical = Schema.Unknown.pipe(
  Schema.decodeTo(CanonicalString, {
    decode: SchemaGetter.transformOrFail((value) =>
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
            new SchemaIssue.InvalidValue(Option.some(value), {
              message: cause instanceof Error ? cause.message : String(cause)
            })
        })
      })
    ),
    encode: SchemaGetter.transform(
      (document) => JSON.parse(document) as unknown
    )
  })
)
