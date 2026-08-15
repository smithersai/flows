/**
 * Deterministic token accounting for context windows.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/** @category models @since 0.1.0 */
export class Count extends Schema.Class<Count>("flows/harness/Tokens/Count")({
  value: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  estimated: Schema.Boolean
}) {}

/** @category models @since 0.1.0 */
export class Segment extends Schema.Class<Segment>("flows/harness/Tokens/Segment")({
  digest: Schema.String,
  zone: Schema.Literals(["prefix", "tail"]),
  tokens: Count
}) {}

/** @category models @since 0.1.0 */
export class Accounting extends Schema.Class<Accounting>("flows/harness/Tokens/Accounting")({
  prefix: Count,
  tail: Count,
  total: Count,
  bySegment: Schema.Array(Segment)
}) {}

/** A deterministic local approximation, not provider billing data.
 * @category models
 * @since 0.1.0
 */
export type Estimator = (text: string) => number

/**
 * Estimates tokens using four characters per token, with code punctuation and
 * newline density accounting for the typically shorter tokens in source text.
 *
 * @category constructors
 * @since 0.1.0
 */
export const estimate: Estimator = (text) => {
  if (text.length === 0) return 0
  const codeCharacters = (text.match(/[{}()[\];=<>`]/g) ?? []).length
  const newlines = (text.match(/\n/g) ?? []).length
  return Math.ceil((text.length + codeCharacters * 0.75 + newlines * 1.5) / 4)
}

/** @category constructors @since 0.1.0 */
export const count = (text: string, estimator: Estimator = estimate): Count =>
  new Count({ value: Math.max(0, Math.ceil(estimator(text))), estimated: true })

/** @category combinators @since 0.1.0 */
export const combine = (segments: ReadonlyArray<Segment>): Accounting => {
  const prefix = segments.filter((segment) => segment.zone === "prefix").reduce(
    (sum, segment) => sum + segment.tokens.value,
    0
  )
  const tail = segments.filter((segment) => segment.zone === "tail").reduce(
    (sum, segment) => sum + segment.tokens.value,
    0
  )
  const estimated = segments.some((segment) => segment.tokens.estimated)
  return new Accounting({
    prefix: new Count({ value: prefix, estimated }),
    tail: new Count({ value: tail, estimated }),
    total: new Count({ value: prefix + tail, estimated }),
    bySegment: segments
  })
}
