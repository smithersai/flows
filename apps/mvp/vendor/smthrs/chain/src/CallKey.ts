/**
 * The durable identity of one settled call within a link.
 *
 * Re-running a link with the same script digest prefix-matches its settled
 * calls by ordinal; editing one character of a script re-keys exactly the
 * calls inside it and nothing else. Governing contract:
 * `docs/specs/Concepts/Chain Slice.md`.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/** @category models @since 0.1.0 */
export const LinkId = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** @category models @since 0.1.0 */
export type LinkId = typeof LinkId.Type

/** @category models @since 0.1.0 */
export const Ordinal = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** @category models @since 0.1.0 */
export type Ordinal = typeof Ordinal.Type

/**
 * The scriptDigest recorded for calls the harness itself issues (bootstrap
 * and recovery author calls), which belong to no authored script.
 *
 * @category constants
 * @since 0.1.0
 */
export const harnessDigest = ""

/** @category models @since 0.1.0 */
export const CallKey = Schema.Struct({
  link: LinkId,
  scriptDigest: Schema.String,
  ordinal: Ordinal,
  entryDigest: Schema.String
})

/** @category models @since 0.1.0 */
export type CallKey = typeof CallKey.Type

/** @category constructors @since 0.1.0 */
export const make = (
  link: number,
  scriptDigest: string,
  ordinal: number,
  entryDigest: string
): CallKey => ({ link, scriptDigest, ordinal, entryDigest })
