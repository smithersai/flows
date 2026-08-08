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
import { Effect, Option, Schema } from "effect"
import { CapabilityPattern, parsePattern } from "./Capability.ts"
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

/**
 * The one decoder-to-attenuator every placement installs.
 *
 * Splitting decoding from attenuation is what keeps a host's refusals honest:
 * this function fails only when the envelope value itself is not readable, and
 * the combinator it returns is pure, so a failure of the wrapped execution can
 * never be mistaken for an envelope refusal. `@smithers/engine`'s
 * `FlowWire.layerInterpreter` takes exactly this shape, so a host installs the
 * canonical interpreter as `layerInterpreter(CapabilityEnvelope.interpreter)`
 * and no placement can grow its own dialect of decoding or attenuation.
 *
 * @category combinators
 * @since 0.1.0
 */
export const interpreter = (
  input: unknown
): Effect.Effect<
  <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  CapabilityEnvelopeError
> => Effect.map(decode(input), apply)

/**
 * Reads the capability strings a flow declaration carries as the patterns of
 * the envelope that declaration's calls travel with.
 *
 * Declarations format capabilities as `action:resource`, and the resource half
 * is a glob (`fs:read:src/**`, `jj:*:repository/**`, the conservative `*`), so
 * they parse as patterns and never as exact capabilities. Parsing lives here,
 * with the envelope it feeds, so every placement derives the same authority
 * from the same declaration. An unparseable entry yields `None` — the caller
 * decides whether that is a refusal or a defect.
 *
 * @category parsing
 * @since 0.1.0
 */
export const patternsOf = (
  capabilities: ReadonlyArray<string>
): Option.Option<ReadonlyArray<CapabilityPattern>> => {
  const patterns: Array<CapabilityPattern> = []
  for (const declared of capabilities) {
    const parsed = parsePattern(declared)
    if (Option.isNone(parsed)) {
      return Option.none()
    }
    patterns.push(parsed.value)
  }
  return Option.some(patterns)
}
