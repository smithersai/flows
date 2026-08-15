/**
 * Flow-native scorer declarations and result validation.
 *
 * @see docs/specs/Concepts/Scoring.md
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ScorerError } from "./ScorerError.ts"

/**
 * Input supplied to a scorer flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  input: Schema.Unknown,
  output: Schema.Unknown,
  groundTruth: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.Unknown),
  latencyMs: Schema.optionalKey(Schema.Finite)
})

/**
 * Input supplied to a scorer flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Successful scorer output. {@link validate} additionally enforces `[0, 1]`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Result = Schema.Struct({
  score: Schema.Finite,
  reason: Schema.optionalKey(Schema.String),
  meta: Schema.optionalKey(Schema.Unknown)
})

/**
 * Successful scorer output.
 *
 * @category models
 * @since 0.1.0
 */
export type Result = typeof Result.Type

/**
 * A scorer is an ordinary flow with an independent declaration identity.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scorer<E = never> extends Flow.Flow<typeof Input, typeof Result, E | ScorerError> {
  readonly scorerKey: string
  readonly score: (input: Input) => Effect.Effect<Result, E | ScorerError>
}

/**
 * Options accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export type MakeOptions<E = never> =
  & Omit<
    Parameters<typeof Flow.make<typeof Input, typeof Result, E | ScorerError>>[0],
    "input" | "output"
  >
  & {
    readonly score: (input: Input) => Effect.Effect<Result, E | ScorerError>
  }

const digest = (text: string): string => {
  let value = 2166136261
  for (const character of text) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(16).padStart(8, "0")
}

/**
 * Declares a scorer flow and derives its scorer key from its own declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <E = never>(options: MakeOptions<E>): Scorer<E> => {
  const { score, ...declaration } = options
  const flow = Flow.make({ ...declaration, input: Input, output: Result })
  const keyMaterial = JSON.stringify({
    name: flow.name ?? null,
    description: flow.description ?? null,
    capabilities: flow.capabilities,
    effects: flow.effects ?? null,
    implementation: flow.implementation ?? null
  })
  return Object.assign(flow, {
    scorerKey: digest(`${keyMaterial}\u0000${score.toString()}`),
    score
  })
}

/**
 * Decodes a scorer result and enforces the finite inclusive score range.
 *
 * @category validation
 * @since 0.1.0
 */
export const validate = (value: unknown): Effect.Effect<Result, ScorerError> =>
  Schema.decodeUnknownEffect(Result)(value).pipe(
    Effect.mapError((cause) =>
      new ScorerError({
        code: "invalid_score",
        message: "A scorer result must match the scorer result schema",
        cause
      })
    ),
    Effect.flatMap((result) =>
      result.score >= 0 && result.score <= 1
        ? Effect.succeed(result)
        : Effect.fail(
          new ScorerError({
            code: "invalid_score",
            message: "A scorer result must have a finite score in [0, 1]"
          })
        )
    )
  )
