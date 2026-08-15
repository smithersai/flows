/**
 * A bounded, alternating deliberation pattern.
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * One immutable contribution to a debate transcript.
 *
 * @category models
 * @since 0.1.0
 */
export interface Turn {
  readonly proponent: unknown
  readonly opponent: unknown
}

/**
 * Configuration for {@link make}.
 *
 * Each participant receives `{ input, transcript }`. The judge receives the
 * final value with the same shape. `rounds` is expanded while this flow is
 * declared, rather than at execution time.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly proponent: Flow.Any
  readonly opponent: Flow.Any
  readonly judge: Flow.Any
  readonly rounds: number
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const invalidRounds = (rounds: number): never => {
  throw new PatternError({
    code: "invalid_decorator",
    message: `Debate rounds must be a positive safe integer, received ${rounds}`
  })
}

/**
 * Builds a fixed-round debate. Transcript entries are accumulated in
 * declaration order and supplied to every subsequent participant.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) invalidRounds(options.rounds)
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [options.proponent, options.opponent, options.judge],
    body: (input) => {
      let current: Node.Node<{ readonly input: unknown; readonly transcript: ReadonlyArray<Turn> }, unknown> = Node
        .succeed({ input, transcript: [] })
      for (let round = 0; round < options.rounds; round++) {
        current = Node.andThen(
          current,
          (state) =>
            Node.andThen(
              call(options.proponent, state),
              (proponent) =>
                Node.map(call(options.opponent, { ...state, proponent }), (opponent) => ({
                  input: state.input,
                  transcript: [...state.transcript, { proponent, opponent }]
                }))
            )
        )
      }
      return Node.andThen(current, (state) => call(options.judge, state))
    }
  })
}
