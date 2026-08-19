/**
 * Deterministic map-reduce declaration pattern.
 *
 * @see docs/specs/Concepts/Higher Order Flows.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * Empty-input policy for {@link make}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type OnEmpty = "reduce" | "succeed" | "fail"

/**
 * Configuration for {@link make}.
 *
 * Inputs to the resulting flow are `{ shards }`. Shard keys use their ordinal
 * (`shard-0`, `shard-1`, …), which makes the reduce input independent of
 * worker completion order.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly map: Flow.Any
  readonly reduce: Flow.Any
  readonly concurrency: number
  readonly onEmpty: OnEmpty
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Makes a map-reduce flow.
 *
 * The flow input is `{ shards }`. Each shard becomes its own map call.
 * Batches are sequenced to enforce the declared concurrency bound, while
 * members inside a batch fan out with `Node.all`.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "MapReduce concurrency must be a positive safe integer"
    })
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [options.map, options.reduce],
    body: (input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        !("shards" in input) ||
        !Array.isArray(input.shards)
      ) {
        throw new PatternError({
          code: "invalid_decorator",
          message: "MapReduce input must contain a shards array"
        })
      }
      const shards = input.shards as ReadonlyArray<unknown>
      if (shards.length === 0) {
        if (options.onEmpty === "fail") {
          throw new PatternError({ code: "exhausted", message: "MapReduce received no shards" })
        }
        return options.onEmpty === "succeed"
          ? Node.succeed([])
          : call(options.reduce, { input, mapped: [] })
      }
      let mapped: Node.Node<ReadonlyArray<unknown>, unknown> = Node.succeed([])
      for (let offset = 0; offset < shards.length; offset += options.concurrency) {
        const members: Record<string, Node.Node<unknown, unknown>> = {}
        const batch = shards.slice(offset, offset + options.concurrency)
        batch.forEach((shard, batchIndex) => {
          const index = offset + batchIndex
          members[`shard-${index}`] = call(options.map, { shard, index, input })
        })
        mapped = Node.andThen(mapped, (previous) =>
          Node.map(Node.all(members), (values) => [
            ...previous,
            ...Object.keys(values).sort((left, right) => Number(left.slice(6)) - Number(right.slice(6))).map((key) =>
              values[key]
            )
          ]))
      }
      return Node.andThen(mapped, (values) => call(options.reduce, { input, mapped: values }))
    }
  })
}
