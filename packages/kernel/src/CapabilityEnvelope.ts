/**
 * The serializable capability envelope.
 *
 * One flow execution request names its authority once, as data, and every
 * placement — a browser Service Worker, a local Bun process, an edge worker,
 * a cloud sandbox — turns that same data into ambient authority the same way:
 * by intersecting it with whatever the executing host already allows. An
 * envelope can therefore only narrow; a request cannot mint capability its
 * host never had, no matter which runtime executes it.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Effect Taxonomy.md`.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect"
import { CapabilityPattern } from "./Capability.ts"
import * as CapabilitySet from "./CapabilitySet.ts"

/**
 * The wire version this module reads and writes. Interpreters fail closed on
 * any other value rather than guessing at future semantics.
 *
 * @category models
 * @since 0.1.0
 */
export const version = "flows/capability-envelope/v1" as const

/**
 * A versioned, JSON-serializable any-of group of capability patterns.
 *
 * The empty pattern list is the empty envelope: it denies every capability,
 * because an intersected empty any-of group can never match. Unrestricted
 * authority is expressed by *omitting* the envelope, never by an envelope
 * value.
 *
 * @category models
 * @since 0.1.0
 */
export class CapabilityEnvelope extends Schema.Class<CapabilityEnvelope>(
  "@smithers/kernel/CapabilityEnvelope"
)({
  version: Schema.Literal(version),
  patterns: Schema.Array(CapabilityPattern)
}) {}

/**
 * Constructs an envelope from capability patterns.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  patterns: ReadonlyArray<CapabilityPattern>
): CapabilityEnvelope => new CapabilityEnvelope({ version, patterns })

/**
 * An envelope that could not be decoded. Interpretation is fail-closed: an
 * uninterpretable envelope refuses execution instead of running with the
 * host's ambient authority.
 *
 * @category errors
 * @since 0.1.0
 */
export class CapabilityEnvelopeError extends Schema.TaggedErrorClass<CapabilityEnvelopeError>()(
  "@smithers/kernel/CapabilityEnvelopeError",
  {
    message: Schema.String
  }
) {}

const decodeEnvelope = Schema.decodeUnknownEffect(CapabilityEnvelope)

/**
 * Decodes an untrusted wire value into an envelope, failing closed.
 *
 * @category parsing
 * @since 0.1.0
 */
export const decode = (
  input: unknown
): Effect.Effect<CapabilityEnvelope, CapabilityEnvelopeError> =>
  decodeEnvelope(input).pipe(
    Effect.mapError((issue) =>
      new CapabilityEnvelopeError({
        message: `The capability envelope is not a valid ${version} value: ${issue.message}`
      })
    )
  )

const encodeEnvelope = Schema.encodeEffect(Schema.toCodecJson(CapabilityEnvelope))

/**
 * Encodes an envelope for the wire.
 *
 * @category encoding
 * @since 0.1.0
 */
export const encode = (
  envelope: CapabilityEnvelope
): Effect.Effect<Schema.Json> => Effect.orDie(encodeEnvelope(envelope))

/**
 * Runs an effect with authority intersected with the envelope's patterns.
 *
 * This is deliberately the only conversion from envelope to authority, and it
 * is monotone: `CapabilitySet.attenuate` intersects, so the executing host's
 * own policy always still applies.
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = (
  envelope: CapabilityEnvelope
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> => CapabilitySet.attenuate(envelope.patterns)

/**
 * Decodes an untrusted wire value and applies it in one step — the shape a
 * host needs to interpret envelopes arriving with remote execution requests.
 *
 * @category combinators
 * @since 0.1.0
 */
export const interpret = (input: unknown) =>
<A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | CapabilityEnvelopeError, R> =>
  Effect.flatMap(decode(input), (envelope) => apply(envelope)(effect))
