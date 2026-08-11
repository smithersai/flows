// Deep reviewed and polished by a human on 2026-08-10.

/**
 * `Activity.retry` re-runs a block while keeping the durable identity of the
 * dispatches inside it: every attempt sees an incremented `CurrentAttempt`,
 * and each dispatch position keeps the ordinal it was allocated on the
 * attempt that first reached it. A nested block shares the enclosing block's
 * pinned ordinals and folds its own cursor positions back on exit.
 */
import { Activity, Flow } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import { runPromise } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it(name, () => runPromise(body()))

const Host = Flow.make("Retry/Host", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id
})

const run = (
  body: Effect.Effect<number, never, any>,
  id: string
): Effect.Effect<number, never, Crypto.Crypto> =>
  Host.execute({ id }, { executionId: id }).pipe(
    Effect.provide(Host.toLayer(() => body).pipe(Layer.provideMerge(layerMemory)))
  ) as Effect.Effect<number, never, Crypto.Crypto>

describe("Activity.retry", () => {
  effect("increments CurrentAttempt for every attempt of the block", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const body = Effect.gen(function*() {
        const attempt = yield* Activity.CurrentAttempt
        attempts.push(attempt)
        return attempt < 3 ? yield* Effect.fail("again") : attempt
      }).pipe(Activity.retry({ times: 5 }), Effect.orDie)

      expect(yield* run(body, "attempts")).toBe(3)
      expect(attempts).toEqual([1, 2, 3])
    }))

  effect("pins each dispatch position to its own identity across attempts", () =>
    Effect.gen(function*() {
      let executions = 0
      const step = Activity.make({
        name: "Retry/step",
        success: Schema.Number,
        execute: Effect.sync(() => ++executions)
      })
      let rounds = 0
      const body = Effect.gen(function*() {
        rounds++
        // two dispatches of one declaration: distinct positions, distinct
        // identities, both replayed on the second attempt
        const first = yield* step
        const second = yield* step
        if (rounds === 1) return yield* Effect.fail("retry once")
        return first + second
      }).pipe(Activity.retry({ times: 3 }), Effect.orDie)

      // Each attempt dispatches both positions; the attempt number is part of
      // the recorded outcome, so the second attempt runs them again.
      expect(yield* run(body, "pinned")).toBe(7)
      expect(executions).toBe(4)
      expect(rounds).toBe(2)
    }))

  effect("a nested block shares the enclosing block's pinned ordinals", () =>
    Effect.gen(function*() {
      let executions = 0
      const inner = Activity.make({
        name: "Retry/inner",
        success: Schema.Number,
        execute: Effect.sync(() => ++executions)
      })
      const before = Activity.make({
        name: "Retry/before",
        success: Schema.Number,
        execute: Effect.sync(() => ++executions)
      })
      let outerRounds = 0
      let innerRounds = 0
      const body = Effect.gen(function*() {
        outerRounds++
        // a dispatch before the nested block, so the block is entered with a
        // non-empty cursor view it must rewind to rather than to zero
        yield* before
        const value = yield* Effect.gen(function*() {
          innerRounds++
          const dispatched = yield* inner
          return innerRounds === 1 ? yield* Effect.fail("inner again") : dispatched
        }).pipe(Activity.retry({ times: 3 }))
        return outerRounds === 1 ? yield* Effect.fail("outer again") : value
      }).pipe(Activity.retry({ times: 3 }), Effect.orDie)

      // The inner block retries once inside the first outer attempt. On the
      // second outer attempt it starts from attempt 1 again and, because the
      // nested block shares the enclosing block's pinned ordinal, the dispatch
      // resolves to the identity already recorded for (position, attempt 1)
      // and replays that outcome instead of executing again.
      expect(yield* run(body, "nested")).toBe(2)
      expect(executions).toBe(4)
      expect(outerRounds).toBe(2)
      expect(innerRounds).toBe(3)
    }))
})
